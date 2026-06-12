FROM rust:1.94-slim AS build
WORKDIR /src
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/vc-server /usr/local/bin/vc-server
ENV VC_DB=/data/vc.sqlite3 VC_BIND=0.0.0.0:8787
VOLUME /data
EXPOSE 8787
CMD ["vc-server"]
