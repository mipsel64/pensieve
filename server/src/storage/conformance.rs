use super::{Change, HistoryFilter, Link, Storage};
use crate::error::Error;

const T: Change = Change {
    author: "t",
    summary: None,
};

/// Behaviour every `Storage` backend must have. Starts from an empty store.
pub(crate) async fn check(storage: &dyn Storage) {
    let redis = "---\ntype: topic\nconfidence: high\n---\nRedis is a cache. See [[ClickHouse|CH]], [[Missing Page#x]] and [[missing page]].\n\
                 ```sh\n[[ -f x ]]\n```\n\n## Eviction\nLRU policies drop keys.\n";
    let first = Change {
        author: "a",
        summary: Some("Create Redis page"),
    };
    assert_eq!(
        storage.put("Redis", redis, Some(0), first).await.unwrap(),
        1
    );
    storage
        .put(
            "ClickHouse",
            "Column store, used with [[redis]].",
            Some(0),
            T,
        )
        .await
        .unwrap();

    assert!(matches!(
        storage.put("redis", "blind overwrite", Some(0), T).await,
        Err(Error::Conflict { rev: 1 })
    ));
    assert!(matches!(
        storage.put("a/b", "x", None, T).await,
        Err(Error::Invalid { .. })
    ));
    assert!(matches!(
        storage.put("Empty", " \n", None, T).await,
        Err(Error::Invalid { .. })
    ));
    assert!(matches!(
        storage
            .put("Typed", "---\ntype: concept\n---\nx", None, T)
            .await,
        Err(Error::Invalid { .. })
    ));
    assert_eq!(
        storage.put("Redis", redis, Some(1), T).await.unwrap(),
        1,
        "unchanged content keeps rev"
    );

    let page = storage.page("redis").await.unwrap();
    assert_eq!(page.title, "Redis");
    assert_eq!(
        (page.kind.as_deref(), page.confidence.as_deref()),
        (Some("topic"), Some("high"))
    );
    assert_eq!(page.backlinks, ["ClickHouse"]);
    assert_eq!(
        page.links,
        [
            Link {
                title: "ClickHouse".into(),
                exists: true,
                kind: None,
            },
            Link {
                title: "Missing Page".into(),
                exists: false,
                kind: None,
            }
        ]
    );
    assert!(matches!(storage.page("nope").await, Err(Error::NotFound)));

    assert_eq!(page.visited_at, None);
    storage.visit("redis").await.unwrap();
    assert!(storage.page("Redis").await.unwrap().visited_at.is_some());
    assert!(matches!(storage.visit("nope").await, Err(Error::NotFound)));

    assert!(matches!(
        storage.edit("Redis", "nope", "x", T).await,
        Err(Error::Invalid { .. })
    ));
    assert!(matches!(
        storage.edit("Redis", "e", "x", T).await,
        Err(Error::Invalid { .. })
    ));
    assert_eq!(
        storage
            .edit("Redis", "a cache", "an in-memory cache", T)
            .await
            .unwrap(),
        2
    );
    let appended = Change {
        author: "b",
        summary: Some("Note volatile-lru"),
    };
    assert_eq!(
        storage
            .append(
                "Redis",
                "eviction",
                "volatile-lru only evicts keys with a TTL.",
                appended
            )
            .await
            .unwrap(),
        3
    );
    assert!(matches!(
        storage.append("Redis", "Nope", "x", T).await,
        Err(Error::Invalid { .. })
    ));

    let hits = storage.search("cache", 10).await.unwrap();
    assert_eq!(hits[0].title, "Redis");
    assert!(hits[0].snippet.contains("«cache»"));
    assert!(storage.search("\"unbalanced OR (", 10).await.is_ok());
    assert_eq!(storage.search("", 1).await.unwrap()[0].title, "Redis");

    let passages = storage
        .search_sections(&["volatile lru".into(), "zzz".into()], 5)
        .await
        .unwrap();
    assert_eq!(
        (passages[0].title.as_str(), passages[0].heading.as_str()),
        ("Redis", "Eviction")
    );
    assert!(passages[0].text.contains("TTL") && !passages[0].text.contains("## Eviction"));
    assert_eq!(passages[0].kind.as_deref(), Some("topic"));
    assert!(
        storage
            .search_sections(&["\"(".into()], 5)
            .await
            .unwrap()
            .is_empty()
    );

    let graph = storage.graph().await.unwrap();
    assert_eq!(graph.nodes.iter().filter(|n| n.missing).count(), 1);
    assert_eq!(graph.links.len(), 3);

    let history = storage
        .history(&HistoryFilter::default(), 10)
        .await
        .unwrap();
    assert_eq!(history.len(), 4);
    assert_eq!(
        (history[0].by.as_str(), history[0].summary.as_deref()),
        ("b", Some("Note volatile-lru"))
    );
    let older = storage
        .history(
            &HistoryFilter {
                before: Some(history[0].seq),
                ..Default::default()
            },
            10,
        )
        .await
        .unwrap();
    assert_eq!(older.len(), 3);
    let by_a = storage
        .history(
            &HistoryFilter {
                author: Some("a".into()),
                ..Default::default()
            },
            10,
        )
        .await
        .unwrap();
    assert_eq!(by_a[0].summary.as_deref(), Some("Create Redis page"));

    let stats = storage.stats().await.unwrap();
    assert_eq!(
        (
            stats.pages,
            stats.links,
            stats.revisions,
            stats.never_visited
        ),
        (2, 3, 4, 1)
    );
    assert_eq!(stats.missing_total, 1);
    assert_eq!(stats.hubs[0].name, "ClickHouse");
    assert!(
        stats
            .kinds
            .iter()
            .any(|k| k.name == "untyped" && k.count == 1)
    );

    assert_eq!(storage.pages().await.unwrap().len(), 2);
}
