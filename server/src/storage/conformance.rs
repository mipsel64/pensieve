use super::{Link, Storage};
use crate::error::Error;

/// Behaviour every `Storage` backend must have. Starts from an empty store and leaves three revisions.
pub(crate) async fn check(storage: &dyn Storage) {
    let redis = "Redis is a cache. See [[ClickHouse|CH]], [[Missing Page#x]] and [[missing page]].\n\
                 ```sh\n[[ -f x ]]\n```";
    assert_eq!(storage.put("Redis", redis, Some(0), "t").await.unwrap(), 1);
    storage
        .put(
            "ClickHouse",
            "Column store, used with [[redis]].",
            Some(0),
            "t",
        )
        .await
        .unwrap();

    assert!(matches!(
        storage.put("redis", "blind overwrite", Some(0), "t").await,
        Err(Error::Conflict { rev: 1 })
    ));
    assert!(matches!(
        storage.put("a/b", "x", None, "t").await,
        Err(Error::Invalid { .. })
    ));
    assert!(matches!(
        storage.put("Empty", " \n", None, "t").await,
        Err(Error::Invalid { .. })
    ));
    assert_eq!(
        storage.put("Redis", redis, Some(1), "t").await.unwrap(),
        1,
        "unchanged content keeps rev"
    );

    let page = storage.page("redis").await.unwrap();
    assert_eq!(page.title, "Redis");
    assert_eq!(page.backlinks, ["ClickHouse"]);
    assert_eq!(
        page.links,
        [
            Link {
                title: "ClickHouse".into(),
                exists: true
            },
            Link {
                title: "Missing Page".into(),
                exists: false
            }
        ]
    );
    assert!(matches!(storage.page("nope").await, Err(Error::NotFound)));

    assert!(matches!(
        storage.edit("Redis", "nope", "x", "t").await,
        Err(Error::Invalid { .. })
    ));
    assert!(matches!(
        storage.edit("Redis", "e", "x", "t").await,
        Err(Error::Invalid { .. })
    ));
    assert_eq!(
        storage
            .edit("Redis", "a cache", "an in-memory cache", "t")
            .await
            .unwrap(),
        2
    );

    let hits = storage.search("cache", 10).await.unwrap();
    assert_eq!(hits[0].title, "Redis");
    assert!(hits[0].snippet.contains("«cache»"));
    assert!(storage.search("\"unbalanced OR (", 10).await.is_ok());
    assert_eq!(storage.search("", 1).await.unwrap()[0].title, "Redis");

    let graph = storage.graph().await.unwrap();
    assert_eq!(graph.nodes.iter().filter(|n| n.missing).count(), 1);
    assert_eq!(graph.links.len(), 3);

    assert_eq!(storage.pages().await.unwrap().len(), 2);
}
