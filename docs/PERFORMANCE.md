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
| Nginx upload | 50MB | `client_max_body_size` |
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

The Prisma client uses a single shared instance (singleton pattern in `lib/prisma.ts`) to prevent connection pool exhaustion in the Next.js dev server's hot-reload cycle. In production, the default Prisma connection pool size (based on `num_cpus * 2 + 1`) applies.

### Query Logging

- **Development**: Prisma logs all SQL queries to stdout (`log: ["query"]`)
- **Production**: Query logging is disabled (production Prisma default)

### Indexing

Key indexes are managed by Prisma's schema and migration system:

- Unique compound indexes on `(productNumber, vendorId)`, `(vendorStyleId, tierId)`, etc.
- Foreign key indexes on all relation fields
- See `prisma/schema.prisma` `@@unique` annotations for the full list
