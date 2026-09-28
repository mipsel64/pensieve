use std::fmt;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    NotFound,
    Conflict {
        rev: i64,
    },
    Invalid {
        reason: &'static str,
    },
    Storage {
        source: Box<dyn std::error::Error + Send + Sync>,
    },
    Rerank {
        reason: String,
    },
}

impl Error {
    pub fn storage(source: impl std::error::Error + Send + Sync + 'static) -> Self {
        Self::Storage {
            source: Box::new(source),
        }
    }

    pub fn rerank(reason: impl Into<String>) -> Self {
        Self::Rerank {
            reason: reason.into(),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => f.write_str("cannot find page"),
            Self::Conflict { rev } => {
                write!(
                    f,
                    "cannot write page: it is at rev {rev}; read it again and retry with base_rev {rev}"
                )
            }
            Self::Invalid { reason } => f.write_str(reason),
            Self::Storage { source } => write!(f, "cannot access storage: {source}"),
            Self::Rerank { reason } => write!(f, "cannot rerank: {reason}"),
        }
    }
}

impl std::error::Error for Error {}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Conflict { .. } => StatusCode::CONFLICT,
            Self::Invalid { .. } => StatusCode::UNPROCESSABLE_ENTITY,
            Self::Rerank { .. } => StatusCode::BAD_GATEWAY,
            Self::Storage { .. } => {
                eprintln!("{self}");
                return (StatusCode::INTERNAL_SERVER_ERROR, "cannot access storage")
                    .into_response();
            }
        };
        (status, self.to_string()).into_response()
    }
}
