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

/// The frontmatter's inner text and the offset where the body starts, when the page opens with a
/// `---` line and a later `---` line closes it.
fn frontmatter(content: &str) -> Option<(&str, usize)> {
    let mut lines = content.split_inclusive('\n');
    let first = lines.next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let mut offset = first.len();
    for line in lines {
        if line.trim_end() == "---" {
            return Some((&content[first.len()..offset], offset + line.len()));
        }
        offset += line.len();
    }
    None
}

/// The value of `key:` in the frontmatter, unquoted.
pub fn field(content: &str, key: &str) -> Option<String> {
    let (block, _) = frontmatter(content)?;
    block.lines().find_map(|line| {
        let value = line
            .strip_prefix(key)?
            .strip_prefix(':')?
            .trim()
            .trim_matches(['"', '\'']);
        (!value.is_empty()).then(|| value.to_owned())
    })
}

/// The page without its frontmatter block.
pub fn body(content: &str) -> &str {
    &content[body_start(content)..]
}

fn body_start(content: &str) -> usize {
    frontmatter(content).map_or(0, |(_, start)| start)
}

/// Lines from `start` that are outside fenced code, with their byte offsets.
fn prose_lines(content: &str, start: usize) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let (mut offset, mut fence) = (start, None::<(char, usize)>);
    for line in content[start..].split_inclusive('\n') {
        let trimmed = line.trim_end();
        let indent = trimmed.len() - trimmed.trim_start_matches(' ').len();
        let marker = trimmed.trim_start_matches(' ');
        let run = |c: char| marker.len() - marker.trim_start_matches(c).len();
        match fence {
            // A fence closes on a bare run of the same character at least as long as its opener.
            Some((c, len))
                if indent < 4
                    && run(c) >= len
                    && marker.trim_start_matches(c).trim().is_empty() =>
            {
                fence = None
            }
            Some(_) => {}
            None if indent < 4 && (run('`') >= 3 || run('~') >= 3) => {
                let c = if run('`') >= 3 { '`' } else { '~' };
                fence = Some((c, run(c)));
            }
            None => out.push((offset, line)),
        }
        offset += line.len();
    }
    out
}

/// ATX headings of levels 1-3 outside fenced code, with `###` labelled by their `##` parent.
fn headings(content: &str) -> Vec<Heading<'_>> {
    let mut out = Vec::new();
    let mut parent = None::<&str>;
    for (start, line) in prose_lines(content, body_start(content)) {
        let trimmed = line.trim_end();
        let marker = trimmed.trim_start_matches(' ');
        if trimmed.len() - marker.len() >= 4 {
            continue;
        }
        let level = marker.len() - marker.trim_start_matches('#').len();
        let rest = &marker[level..];
        if !(1..=3).contains(&level) || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
            continue;
        }
        // An optional closing run of `#` is not part of the heading.
        let text = rest.trim().trim_end_matches('#').trim_end();
        let label = match (level, parent) {
            (3, Some(parent)) => format!("{parent} › {text}"),
            _ => text.to_owned(),
        };
        parent = match level {
            1 => None,
            2 => Some(text),
            _ => parent,
        };
        out.push(Heading {
            start,
            body_start: start + line.len(),
            level,
            text,
            label,
        });
    }
    out
}

/// Headings that start sections: all of them except a `#` title that opens the body, which
/// belongs to the lead section.
fn section_headings(content: &str) -> Vec<Heading<'_>> {
    let mut headings = headings(content);
    if headings.first().is_some_and(|h| h.level == 1) {
        headings.remove(0);
    }
    headings
}

/// The page body split at headings; empty sections are dropped.
pub fn sections(content: &str) -> Vec<Section> {
    let headings = section_headings(content);
    let lead_end = headings.first().map_or(content.len(), |h| h.start);
    let lead = Section {
        heading: String::new(),
        body: trim_blank_lines(&content[body_start(content)..lead_end]),
    };
    let rest = headings.iter().enumerate().map(|(i, h)| {
        let end = headings.get(i + 1).map_or(content.len(), |next| next.start);
        Section {
            heading: h.label.clone(),
            body: trim_blank_lines(&content[h.body_start..end]),
        }
    });
    std::iter::once(lead)
        .chain(rest)
        .filter(|s| !s.body.is_empty())
        .collect()
}

/// Section labels in document order, for listing to agents.
pub fn section_names(content: &str) -> Vec<String> {
    section_headings(content)
        .into_iter()
        .map(|h| h.label)
        .collect()
}

/// Byte range of the named section (heading line included), running to the next heading of the
/// same or higher level. Matches the heading or its `Parent › Heading` label, ignoring ASCII case.
pub fn section_range(content: &str, name: &str) -> Option<(usize, usize)> {
    let name = name.trim().trim_start_matches('#').trim();
    let headings = section_headings(content);
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
    let text = trim_blank_lines(text);
    let before = before.trim_end_matches(['\n', '\r']);
    Some(if after.is_empty() {
        format!("{before}\n\n{text}\n")
    } else {
        format!("{before}\n\n{text}\n\n{after}")
    })
}

/// Obsidian-style `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`, outside code and not
/// escaped. The first spelling wins among ASCII case variants.
pub fn wikilinks(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut links = Vec::new();
    for (_, line) in prose_lines(content, 0) {
        // Even-numbered segments between backticks are outside inline code.
        for text in line.split('`').step_by(2) {
            let mut rest = text;
            while let Some(open) = rest.find("[[") {
                let escaped = rest[..open].ends_with('\\');
                rest = &rest[open + 2..];
                let Some(close) = rest.find("]]") else { break };
                let target = rest[..close]
                    .split(['|', '#'])
                    .next()
                    .unwrap_or_default()
                    .trim();
                let target = target.strip_suffix(".md").unwrap_or(target);
                if !escaped && !target.is_empty() && seen.insert(target.to_ascii_lowercase()) {
                    links.push(target.to_owned());
                }
                rest = &rest[close + 2..];
            }
        }
    }
    links
}

/// Whether `text` contains `phrase` as whole words, ignoring case.
pub fn mentions(text: &str, phrase: &str) -> bool {
    let (text, phrase) = (text.to_lowercase(), phrase.to_lowercase());
    let word = |c: Option<char>| c.is_some_and(char::is_alphanumeric);
    text.match_indices(&phrase).any(|(i, _)| {
        !word(text[..i].chars().next_back()) && !word(text[i + phrase.len()..].chars().next())
    })
}

/// `text` without leading blank lines or trailing whitespace; indentation of the first line is kept.
fn trim_blank_lines(text: &str) -> String {
    let first = text
        .find(|c: char| !c.is_whitespace())
        .unwrap_or(text.len());
    let start = text[..first].rfind('\n').map_or(0, |i| i + 1);
    text[start..].trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "---\ntags: [x]\ntype: \"runbook\"\n---\n# Deploy\nIntro text.\n\n## Steps\nRun it.\n````sh\n## not a heading\n```\n~~~\n````\n### Rollback ###\nUndo it.\n\n## Empty\n\n  ## Gotchas\n    indented code\nWatch out.\n# Appendix\n### Orphan\nNo parent.\n";

    #[test]
    fn frontmatter_sections_and_appends() {
        assert_eq!(field(PAGE, "type").as_deref(), Some("runbook"));
        assert_eq!(field(PAGE, "confidence"), None);
        assert_eq!(field("no frontmatter\ntype: x", "type"), None);
        assert_eq!(
            field("---\r\ntype: topic\r\n---\r\nBody", "type").as_deref(),
            Some("topic")
        );
        assert_eq!(
            field("---\ntype: topic\n---not a delimiter\nBody", "type"),
            None
        );
        assert_eq!(body("---\ntype: topic\n---\nBody"), "Body");

        let sections = sections(PAGE);
        let labels: Vec<_> = sections.iter().map(|s| s.heading.as_str()).collect();
        assert_eq!(
            labels,
            ["", "Steps", "Steps › Rollback", "Gotchas", "Orphan"]
        );
        assert_eq!(sections[0].body, "# Deploy\nIntro text.");
        assert!(sections[1].body.contains("## not a heading") && sections[1].body.contains("~~~"));
        assert_eq!(sections[3].body, "    indented code\nWatch out.");
        assert_eq!(
            section_names(PAGE),
            [
                "Steps",
                "Steps › Rollback",
                "Empty",
                "Gotchas",
                "Appendix",
                "Orphan"
            ]
        );

        let (start, end) = section_range(PAGE, "steps").unwrap();
        assert!(PAGE[start..end].contains("Undo it.") && !PAGE[start..end].contains("## Empty"));
        let (start, end) = section_range(PAGE, "Gotchas").unwrap();
        assert!(
            !PAGE[start..end].contains("Appendix"),
            "a # heading ends the section"
        );
        let appended =
            append_to_section(PAGE, "## Steps", "\n    code first\nthen text\n").unwrap();
        assert!(
            appended.contains("Undo it.\n\n    code first\nthen text\n\n## Empty"),
            "{appended}"
        );
        let at_end = append_to_section(PAGE, "orphan", "Also this.").unwrap();
        assert!(at_end.ends_with("No parent.\n\nAlso this.\n"));
        assert_eq!(append_to_section(PAGE, "Nope", "x"), None);
    }

    #[test]
    fn links_and_mentions() {
        let text = "---\nsources: [\"[[Source]]\"]\n---\nSee [[ClickHouse|CH]], [[Missing Page#x]] and [[missing page]].\n\
                    ```sh\n[[ -f x ]]\n```\n~~~\n[[Tilde]]\n~~~\nUse `[[Example]]` or \\[[Escaped]] literally, then [[Real]].";
        assert_eq!(
            wikilinks(text),
            ["Source", "ClickHouse", "Missing Page", "Real"]
        );
        assert!(mentions("We use Redis Cluster here.", "redis cluster"));
        assert!(!mentions("Rediscover it.", "Redis"));
        assert!(mentions("Ends with Redis", "redis"));
    }
}
