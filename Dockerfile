FROM node:26-bookworm-slim AS web
WORKDIR /web
COPY server/web/package.json server/web/package-lock.json ./
RUN npm ci
COPY server/web/ ./
RUN npm run build

FROM rust:1.98-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY server/Cargo.toml server/build.rs ./server/
COPY server/src ./server/src
COPY --from=web /web/dist ./server/web/dist
ARG GIT_SHA=unknown
ARG BUILD_DATE
RUN cargo build --locked --release --bin pensieve \
    && install -d -m 0700 /var/lib/pensieve

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/target/release/pensieve /usr/local/bin/pensieve
COPY --from=build --chown=65532:65532 /var/lib/pensieve /var/lib/pensieve
COPY LICENSE /usr/share/licenses/pensieve/LICENSE
ENV HOME=/home/nonroot PENSIEVE_DB=/var/lib/pensieve/pensieve.db PENSIEVE_LISTEN=0.0.0.0:7878
USER 65532:65532
RUN ["/usr/local/bin/pensieve", "--version"]
VOLUME /var/lib/pensieve
EXPOSE 7878
ENTRYPOINT ["/usr/local/bin/pensieve"]
CMD ["serve"]
