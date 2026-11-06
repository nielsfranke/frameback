# Integration tests

Run against a real, migrated Postgres (never staging or live):

```bash
docker run -d --name frameback-devdb -e POSTGRES_USER=dev -e POSTGRES_PASSWORD=dev \
  -e POSTGRES_DB=frameback -p 127.0.0.1:55432:5432 postgres:16-alpine
docker exec frameback-devdb psql -U dev -d frameback -c 'CREATE DATABASE frameback_test'
DATABASE_URL=postgresql://dev:dev@127.0.0.1:55432/frameback_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://dev:dev@127.0.0.1:55432/frameback_test npm test
```

Without `TEST_DATABASE_URL`, `npm test` runs the unit tests only. CI provides the database.
