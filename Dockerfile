FROM node:25-bookworm-slim AS web
WORKDIR /web
COPY server/web/package.json server/web/package-lock.json ./
RUN npm ci
COPY server/web/ ./
RUN npm run build

FROM rust:1.98-bookworm AS build
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY client ./client
COPY server/Cargo.toml server/build.rs ./server/
COPY server/src ./server/src
COPY --from=web /web/dist ./server/web/dist
RUN cargo build --locked --release --bin pensieve-server \
    && install -d -m 0700 /var/lib/pensieve

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /build/target/release/pensieve-server /usr/local/bin/pensieve-server
COPY --from=build --chown=65532:65532 /var/lib/pensieve /var/lib/pensieve
COPY LICENSE /usr/share/licenses/pensieve/LICENSE
ENV HOME=/home/nonroot PENSIEVE_DB=/var/lib/pensieve/pensieve.db PENSIEVE_LISTEN=0.0.0.0:7878
USER 65532:65532
RUN ["/usr/local/bin/pensieve-server", "--version"]
VOLUME /var/lib/pensieve
EXPOSE 7878
ENTRYPOINT ["/usr/local/bin/pensieve-server"]
CMD ["serve"]
