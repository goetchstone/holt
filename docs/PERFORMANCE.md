# Performance and Capacity Limits

## Import Pipeline

### Timeout Configuration

| Layer | Timeout | Config Location |
|-------|---------|-----------------|
| Nginx proxy | 300s | `nginx/nginx.conf` (`proxy_read_timeout`) |
| Prisma transaction | 300s | Import API handlers (`timeout: 300000`) |
| Next.js body parser | N/A | `export const config = { api: { bodyParser: { sizeLimit: "20mb" } } }` |

### Payload Size Limits

| Limit | Value | Source |
|-------|-------|--------|
| Nginx upload | 300MB | `client_max_body_size` in `nginx/nginx.conf` |
| Body parser | 20MB | Per-route `bodyParser.sizeLimit` |
| JSON payload | ~20MB effective | Limited by body parser |

### Estimated Capacity

Based on validation sizing tests (`npm run test:integration`):

| Product Count | JSON Size | Validation Time | Notes |
|---------------|-----------|-----------------|-------|
| 100 | ~25KB | <50ms | Typical small vendor |
| 500 | ~125KB | <100ms | Typical medium vendor |
| 1,000 | ~250KB | <200ms | Large price book |
| 2,000 | ~500KB | <500ms | Very large price book |

The theoretical limit before hitting the 20MB body parser is approximately 80,000+ products. Real-world price books are typically 200-800 products.

### Recommendations

- For price books under 2,000 products: import as a single batch (no changes needed)
- For price books over 2,000 products: split into multiple import batches by collection or product type
- The 300-second transaction timeout is the practical bottleneck for very large imports -- the database write operations (upserts) are the slowest part, not validation or parsing
- Monitor import times via audit logs: `docker compose logs app | grep "IMPORT_WHOLESALE"`

## Database Performance

### Connection Pool

The Prisma client uses a single shared instance per process (singleton pattern in
`lib/prisma.ts`). Prisma 7 talks to Postgres through the `pg` driver adapter, so the
pool is a `pg.Pool`, and its size is `PG_POOL_MAX` -- **10** when unset, and
docker-compose.yml passes `PG_POOL_MAX=${PG_POOL_MAX:-10}` to every app process. The
`connection_limit` and `pool_timeout` parameters some `DATABASE_URL`s carry are not
read by `pg.Pool` and change nothing. (Prisma's old `num_cpus * 2 + 1` default belonged
to its Rust engine, which this version no longer uses.)

Each app process has its own pool, so a deployment opens up to
`APP_REPLICAS x PG_POOL_MAX` connections. Keep that under Postgres's `max_connections`
(100 by default) with room for backups, migrations and psql. How many processes and
what size of server a deployment needs: [HOSTING.md](./HOSTING.md).

### Query Logging

- **Development**: Prisma logs all SQL queries to stdout (`log: ["query"]`)
- **Production**: errors only (`log: ["error"]` in `lib/prisma.ts`)

### Indexing

Key indexes are managed by Prisma's schema and migration system:

- Unique compound indexes such as `(vendorStyleId, tierId)`. There is NO unique index
  on `(productNumber, vendorId)`: `Product.productNumber` is a plain, unindexed column,
  so two products may share a number, and a lookup by it scans.
- Foreign key indexes on all relation fields
- See `prisma/schema.prisma` `@@unique` annotations for the full list
