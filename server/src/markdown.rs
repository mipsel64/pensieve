//! Page parsing shared by storage and the tools: frontmatter, sections and links.

use std::collections::HashSet;

/// Allowed values of the frontmatter `type` field.
pub const KINDS: [&str; 7] = [
    "topic",
    "entity",
    "source",
    "synthesis",
    "runbook",
    "incident",
    "audit",
];

#[derive(Clone, Debug, PartialEq)]
pub struct Section {
    /// `Heading`, `Parent › Heading` for `###`, or empty for the text before the first heading.
    pub heading: String,
    pub body: String,
}

struct Heading<'a> {
    start: usize,
    body_start: usize,
    level: usize,
    text: &'a str,
    label: String,
}

/// The value of `key:` in the leading `---` frontmatter block, unquoted.
pub fn field(content: &str, key: &str) -> Option<String> {
    let block = content.strip_prefix("---\n")?.split("\n---").next()?;
    block.lines().find_map(|line| {
        let value = line
            .strip_prefix(key)?
            .strip_prefix(':')?
            .trim()
            .trim_matches(['"', '\'']);
        (!value.is_empty()).then(|| value.to_owned())
    })
}

/// Byte offset where the body starts, after any frontmatter block.
fn body_start(content: &str) -> usize {
    let Some(rest) = content.strip_prefix("---\n") else {
        return 0;
    };
    match rest.find("\n---") {
        Some(end) => {
            let after = 4 + end + 4;
            after
                + content[after..]
                    .find('\n')
                    .map_or(content.len() - after, |i| i + 1)
        }
        None => 0,
    }
}

/// The page without its frontmatter block.
pub fn body(content: &str) -> &str {
    &content[body_start(content)..]
}

/// `##` and `###` headings outside fenced code.
fn headings(content: &str) -> Vec<Heading<'_>> {
    let mut out = Vec::new();
    let (mut offset, mut fence, mut parent) = (body_start(content), false, None::<&str>);
    for line in content[offset..].split_inclusive('\n') {
        let text = line.trim_end();
        if text.starts_with("```") || text.starts_with("~~~") {
            fence = !fence;
        } else if !fence {
            let level = if text.starts_with("### ") {
                3
            } else if text.starts_with("## ") {
                2
            } else {
                0
            };
            if level > 0 {
                let heading = text[level + 1..].trim();
                let label = match (level, parent) {
                    (3, Some(parent)) => format!("{parent} › {heading}"),
                    _ => heading.to_owned(),
                };
                if level == 2 {
                    parent = Some(heading);
                }
                out.push(Heading {
                    start: offset,
                    body_start: offset + line.len(),
                    level,
                    text: heading,
                    label,
                });
            }
        }
        offset += line.len();
    }
    out
}

/// The page body split at `##`/`###` headings; empty sections are dropped.
pub fn sections(content: &str) -> Vec<Section> {
    let headings = headings(content);
    let lead_end = headings.first().map_or(content.len(), |h| h.start);
    let lead = Section {
        heading: String::new(),
        body: content[body_start(content)..lead_end].trim().to_owned(),
    };
    let rest = headings.iter().enumerate().map(|(i, h)| {
        let end = headings.get(i + 1).map_or(content.len(), |next| next.start);
        Section {
            heading: h.label.clone(),
            body: content[h.body_start..end].trim().to_owned(),
        }
    });
    std::iter::once(lead)
        .chain(rest)
        .filter(|s| !s.body.is_empty())
        .collect()
}

/// Section labels in document order, for listing to agents.
pub fn section_names(content: &str) -> Vec<String> {
    headings(content).into_iter().map(|h| h.label).collect()
}

/// Byte range of the named section (heading line included), running to the next heading of the
/// same or higher level. Matches the heading or its `Parent › Heading` label, ignoring case.
pub fn section_range(content: &str, name: &str) -> Option<(usize, usize)> {
    let name = name.trim().trim_start_matches('#').trim();
    let headings = headings(content);
    let i = headings
        .iter()
        .position(|h| h.text.eq_ignore_ascii_case(name) || h.label.eq_ignore_ascii_case(name))?;
    let end = headings[i + 1..]
        .iter()
        .find(|h| h.level <= headings[i].level)
        .map_or(content.len(), |h| h.start);
    Some((headings[i].start, end))
}

/// `content` with `text` added as the last paragraph of the named section.
pub fn append_to_section(content: &str, name: &str, text: &str) -> Option<String> {
    let (_, end) = section_range(content, name)?;
    let (before, after) = content.split_at(end);
    Some(if after.is_empty() {
        format!("{}\n\n{}\n", before.trim_end(), text.trim())
    } else {
        format!("{}\n\n{}\n\n{after}", before.trim_end(), text.trim())
    })
}

/// Obsidian-style `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]` outside fenced code,
/// first spelling wins among case variants.
pub fn wikilinks(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    content
        .split("```")
        .step_by(2)
        .flat_map(|text| text.split("[[").skip(1))
        .filter_map(|rest| rest.split_once("]]"))
        .filter_map(|(inner, _)| {
            let target = inner
                .split(['|', '#'])
                .next()?
                .trim()
                .trim_end_matches('\\');
            let target = target.strip_suffix(".md").unwrap_or(target);
            (!target.is_empty() && !target.contains('\n')).then_some(target)
        })
        .filter(|target| seen.insert(target.to_lowercase()))
        .map(str::to_owned)
        .collect()
}

/// Whether `text` contains `phrase` as whole words, ignoring case.
pub fn mentions(text: &str, phrase: &str) -> bool {
    let (text, phrase) = (text.to_lowercase(), phrase.to_lowercase());
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    text.match_indices(&phrase).any(|(i, _)| {
        !word(text[..i].chars().next_back()) && !word(text[i + phrase.len()..].chars().next())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "---\ntags: [x]\ntype: \"runbook\"\n---\n# Deploy\nIntro text.\n\n## Steps\nRun it.\n```sh\n## not a heading\n```\n### Rollback\nUndo it.\n\n## Empty\n\n## Gotchas\nWatch out.\n";

    #[test]
    fn frontmatter_sections_and_appends() {
        assert_eq!(field(PAGE, "type").as_deref(), Some("runbook"));
        assert_eq!(field(PAGE, "confidence"), None);
        assert_eq!(field("no frontmatter\ntype: x", "type"), None);

        let sections = sections(PAGE);
        let labels: Vec<_> = sections.iter().map(|s| s.heading.as_str()).collect();
        assert_eq!(labels, ["", "Steps", "Steps › Rollback", "Gotchas"]);
        assert_eq!(sections[0].body, "# Deploy\nIntro text.");
        assert!(sections[1].body.contains("## not a heading"));
        assert_eq!(
            section_names(PAGE),
            ["Steps", "Steps › Rollback", "Empty", "Gotchas"]
        );

        let (start, end) = section_range(PAGE, "steps").unwrap();
        assert!(PAGE[start..end].contains("Undo it.") && !PAGE[start..end].contains("## Empty"));
        let appended = append_to_section(PAGE, "## Steps", "Check logs.").unwrap();
        assert!(appended.contains("Undo it.\n\nCheck logs.\n\n## Empty"));
        let at_end = append_to_section(PAGE, "gotchas", "Also this.").unwrap();
        assert!(at_end.ends_with("Watch out.\n\nAlso this.\n"));
        assert_eq!(append_to_section(PAGE, "Nope", "x"), None);
    }

    #[test]
    fn links_and_mentions() {
        let text = "See [[ClickHouse|CH]], [[Missing Page#x]] and [[missing page]].\n```sh\n[[ -f x ]]\n```";
        assert_eq!(wikilinks(text), ["ClickHouse", "Missing Page"]);
        assert!(mentions("We use Redis Cluster here.", "redis cluster"));
        assert!(!mentions("Rediscover it.", "Redis"));
        assert!(mentions("Ends with Redis", "redis"));
    }
}
