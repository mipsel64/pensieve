use std::time::{Duration, SystemTime};

use super::{Change, HistoryFilter, Link, OAuthClient, OAuthToken, Storage, TokenKind, TokenOwner};
use crate::error::Error;

const T: Change = Change {
    author: "t",
    summary: None,
};

/// Behaviour every `Storage` backend must have. Starts from an empty store.
pub(crate) async fn check(storage: &dyn Storage) {
    let week_ago = SystemTime::now() - Duration::from_secs(7 * 24 * 60 * 60);
    let tomorrow = SystemTime::now() + Duration::from_secs(24 * 60 * 60);
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

    let hits = storage.search("cache", None, 10).await.unwrap();
    assert_eq!(hits[0].title, "Redis");
    assert!(hits[0].snippet.contains("«cache»"));
    assert!(storage.search("\"unbalanced OR (", None, 10).await.is_ok());
    assert_eq!(storage.search("", None, 1).await.unwrap()[0].title, "Redis");

    let passages = storage
        .search_sections(&["volatile lru".into(), "zzz".into()], None, week_ago, 5)
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
            .search_sections(&["\"(".into()], None, week_ago, 5)
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

    storage
        .put(
            "Scratchpad",
            "---\ntype: journal\n---\nRedis cache. volatile-lru only evicts keys with a TTL.",
            None,
            T,
        )
        .await
        .unwrap();
    assert_eq!(
        storage.page("Scratchpad").await.unwrap().kind.as_deref(),
        Some("journal")
    );
    assert_eq!(storage.search("", None, 1).await.unwrap()[0].title, "Redis");
    assert_eq!(
        storage.search("cache", None, 1).await.unwrap()[0].title,
        "Redis"
    );
    assert_eq!(
        storage.search("cache", Some("journal"), 1).await.unwrap()[0].title,
        "Scratchpad"
    );
    assert_eq!(
        storage.search("", Some("journal"), 1).await.unwrap()[0].title,
        "Scratchpad"
    );
    assert!(
        storage
            .search("cache", Some("runbook"), 5)
            .await
            .unwrap()
            .is_empty()
    );
    let old = storage
        .search_sections(&["volatile lru".into()], None, tomorrow, 5)
        .await
        .unwrap();
    assert!(old.iter().any(|p| p.title == "Redis"));
    assert!(
        old.iter().all(|p| p.title != "Scratchpad"),
        "journal older than the cutoff is skipped"
    );
    let recent = storage
        .search_sections(&["volatile lru".into()], None, week_ago, 5)
        .await
        .unwrap();
    assert!(
        recent.iter().any(|p| p.title == "Scratchpad"),
        "journal newer than the cutoff is recalled"
    );
    assert_eq!(
        storage
            .search_sections(&["volatile lru".into()], Some("journal"), tomorrow, 1)
            .await
            .unwrap()[0]
            .title,
        "Scratchpad"
    );
    assert!(
        storage
            .search_sections(&["volatile lru".into()], Some("runbook"), week_ago, 5)
            .await
            .unwrap()
            .is_empty()
    );
    let stats = storage.stats().await.unwrap();
    assert!(!stats.orphans.iter().any(|t| t == "Scratchpad"));
    assert!(stats.stale.iter().all(|p| p.title != "Scratchpad"));

    assert_eq!(storage.settings().await.unwrap(), None);
    storage.save_settings(r#"{"a":1}"#).await.unwrap();
    storage.save_settings(r#"{"a":2}"#).await.unwrap();
    assert_eq!(
        storage.settings().await.unwrap().as_deref(),
        Some(r#"{"a":2}"#)
    );

    check_oauth(storage).await;
}

async fn check_oauth(storage: &dyn Storage) {
    assert_eq!(storage.secret("session", b"first").await.unwrap(), b"first");
    assert_eq!(
        storage.secret("session", b"later").await.unwrap(),
        b"first",
        "a later fresh value replaced the stable secret"
    );

    let stale = OAuthClient {
        id: "stale-client".into(),
        name: "Stale".into(),
        redirect_uris: vec!["https://stale.example/cb".into()],
        created_at: 10,
    };
    let client = OAuthClient {
        id: "client".into(),
        name: "Client".into(),
        redirect_uris: vec!["https://client.example/cb".into()],
        created_at: 10,
    };
    storage.register_client(&stale, 0).await.unwrap();
    storage.register_client(&client, 0).await.unwrap();
    storage
        .create_grant(
            "a-grant",
            &client.id,
            "user@example.com",
            "https://pensieve.test/mcp",
            &[
                OAuthToken {
                    hash: "a-access".into(),
                    kind: TokenKind::Access,
                    expires_at: 200,
                },
                OAuthToken {
                    hash: "a-refresh".into(),
                    kind: TokenKind::Refresh,
                    expires_at: 10_000,
                },
            ],
            100,
        )
        .await
        .unwrap();
    let fresh = OAuthClient {
        id: "fresh-client".into(),
        name: "Fresh".into(),
        redirect_uris: vec!["https://fresh.example/cb".into()],
        created_at: 200,
    };
    storage.register_client(&fresh, 50).await.unwrap();
    assert_eq!(storage.client(&stale.id).await.unwrap(), None);
    assert_eq!(
        storage.client(&client.id).await.unwrap(),
        Some(client.clone())
    );
    assert_eq!(storage.client(&fresh.id).await.unwrap(), Some(fresh));

    let owner = TokenOwner {
        grant_id: "a-grant".into(),
        client_id: client.id.clone(),
        email: "user@example.com".into(),
        resource: "https://pensieve.test/mcp".into(),
    };
    assert_eq!(
        storage
            .token_owner("a-access", TokenKind::Access, 199)
            .await
            .unwrap(),
        Some(owner.clone())
    );
    assert_eq!(
        storage
            .token_owner("a-access", TokenKind::Refresh, 199)
            .await
            .unwrap(),
        None,
        "a token was accepted under the wrong kind"
    );
    assert_eq!(
        storage
            .token_owner("a-access", TokenKind::Access, 200)
            .await
            .unwrap(),
        None,
        "a token remained valid at its expiry second"
    );
    assert_eq!(
        storage
            .token_owner("a-refresh", TokenKind::Refresh, 200)
            .await
            .unwrap(),
        Some(owner.clone())
    );

    storage
        .create_grant(
            "b-grant",
            &client.id,
            "user@example.com",
            "https://pensieve.test/mcp",
            &[
                OAuthToken {
                    hash: "b-access".into(),
                    kind: TokenKind::Access,
                    expires_at: 10_000,
                },
                OAuthToken {
                    hash: "b-old-refresh".into(),
                    kind: TokenKind::Refresh,
                    expires_at: 10_000,
                },
            ],
            100,
        )
        .await
        .unwrap();
    let wrong_client_tokens = [OAuthToken {
        hash: "wrong-client-new".into(),
        kind: TokenKind::Access,
        expires_at: 10_000,
    }];
    assert_eq!(
        storage
            .rotate_refresh("b-old-refresh", "another-client", &wrong_client_tokens, 150)
            .await
            .unwrap(),
        None
    );
    assert!(
        storage
            .token_owner("b-old-refresh", TokenKind::Refresh, 150)
            .await
            .unwrap()
            .is_some(),
        "a failed rotation consumed the refresh token"
    );
    assert_eq!(
        storage
            .token_owner("wrong-client-new", TokenKind::Access, 150)
            .await
            .unwrap(),
        None,
        "a failed rotation inserted new tokens"
    );

    let rotated = storage
        .rotate_refresh(
            "b-old-refresh",
            &client.id,
            &[
                OAuthToken {
                    hash: "b-new-access".into(),
                    kind: TokenKind::Access,
                    expires_at: 10_000,
                },
                OAuthToken {
                    hash: "b-new-refresh".into(),
                    kind: TokenKind::Refresh,
                    expires_at: 10_000,
                },
            ],
            150,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rotated.grant_id, "b-grant");
    assert_eq!(rotated.client_id, client.id);
    assert_eq!(rotated.email, "user@example.com");
    assert_eq!(rotated.resource, "https://pensieve.test/mcp");
    assert_eq!(
        storage
            .token_owner("b-old-refresh", TokenKind::UsedRefresh, 150)
            .await
            .unwrap()
            .map(|owner| owner.grant_id),
        Some("b-grant".into())
    );
    assert_eq!(
        storage
            .token_owner("b-old-refresh", TokenKind::Refresh, 150)
            .await
            .unwrap(),
        None
    );
    assert!(
        storage
            .token_owner("b-new-access", TokenKind::Access, 150)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        storage
            .token_owner("b-new-refresh", TokenKind::Refresh, 150)
            .await
            .unwrap()
            .is_some()
    );

    let replay_tokens = [OAuthToken {
        hash: "replay-new".into(),
        kind: TokenKind::Access,
        expires_at: 10_000,
    }];
    assert_eq!(
        storage
            .rotate_refresh("b-old-refresh", &client.id, &replay_tokens, 151)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        storage
            .token_owner("replay-new", TokenKind::Access, 151)
            .await
            .unwrap(),
        None,
        "a used refresh token inserted replacement tokens"
    );
    let grants = storage.grants().await.unwrap();
    assert_eq!(
        grants
            .iter()
            .find(|grant| grant.id == "b-grant")
            .unwrap()
            .refreshed_at,
        "1970-01-01T00:02:30Z",
        "a failed replay changed refreshed_at"
    );

    storage
        .create_grant(
            "purge-grant",
            &client.id,
            "user@example.com",
            "https://pensieve.test/mcp",
            &[
                OAuthToken {
                    hash: "purge-access".into(),
                    kind: TokenKind::Access,
                    expires_at: 200,
                },
                OAuthToken {
                    hash: "purge-used-refresh".into(),
                    kind: TokenKind::UsedRefresh,
                    expires_at: 10_000,
                },
            ],
            100,
        )
        .await
        .unwrap();
    assert!(
        storage
            .token_owner("purge-used-refresh", TokenKind::UsedRefresh, 100)
            .await
            .unwrap()
            .is_some()
    );
    storage
        .create_grant(
            "c-grant",
            &client.id,
            "user@example.com",
            "https://pensieve.test/mcp",
            &[
                OAuthToken {
                    hash: "c-access".into(),
                    kind: TokenKind::Access,
                    expires_at: 10_000,
                },
                OAuthToken {
                    hash: "c-refresh".into(),
                    kind: TokenKind::Refresh,
                    expires_at: 10_000,
                },
            ],
            200,
        )
        .await
        .unwrap();
    assert_eq!(
        storage
            .token_owner("purge-used-refresh", TokenKind::UsedRefresh, 100)
            .await
            .unwrap(),
        None,
        "the purge kept a grant with only a used refresh token"
    );

    let grants = storage.grants().await.unwrap();
    let ids: Vec<_> = grants.iter().map(|grant| grant.id.as_str()).collect();
    assert_eq!(ids, ["c-grant", "a-grant", "b-grant"]);
    assert_eq!(grants[0].client_name, "Client");
    assert_eq!(grants[0].email, "user@example.com");
    assert_eq!(grants[0].created_at, "1970-01-01T00:03:20Z");
    assert_eq!(grants[0].refreshed_at, "1970-01-01T00:03:20Z");
    assert_eq!(grants[1].created_at, "1970-01-01T00:01:40Z");
    assert_eq!(grants[2].created_at, "1970-01-01T00:01:40Z");

    assert!(storage.revoke_grant("b-grant").await.unwrap());
    for (hash, kind) in [
        ("b-old-refresh", TokenKind::UsedRefresh),
        ("b-new-access", TokenKind::Access),
        ("b-new-refresh", TokenKind::Refresh),
    ] {
        assert_eq!(
            storage.token_owner(hash, kind, 150).await.unwrap(),
            None,
            "revoking a grant left {hash} usable"
        );
    }
    assert!(!storage.revoke_grant("b-grant").await.unwrap());
}
