# How to run the API Gateway

Run everything from the `api-gateway/` folder. On Windows use **Git Bash**.
You need Node.js 22+ and Docker Desktop (it must be running).

## 1. Install and check

    npm install
    docker compose up -d redis        # the tests need a real Redis
    npm run check                     # typecheck + lint + all tests

## 2. Start the full stack

Starts Redis, two mock services, and two gateway copies on ports 3001 and 3002.

    node scripts/dev-keys.mjs         # makes test-only login keys (once)
    docker compose up -d --build

## 3. Try it

    TOKEN=$(node scripts/mint-token.mjs alice)
    curl -i -H "Authorization: Bearer $TOKEN" 127.0.0.1:3001/api/v1/service-a/ping
    curl -i 127.0.0.1:3001/api/v1/service-a/ping          # no token -> 401
    curl 127.0.0.1:3001/health/ready                      # {"status":"ready"}
    curl 127.0.0.1:3001/metrics                           # counters

Use `127.0.0.1`, not `localhost` (on Windows `localhost` adds a 200 ms delay).

## 4. Record the demo

    bash scripts/demo.sh              # press Enter at each step
    AUTO=1 bash scripts/demo.sh       # no pauses, for a quick check

## 5. Benchmarks (about 16 minutes, don't use the PC meanwhile)

    ONLY=baseline,failure bash scripts/bench.sh
    TRIALS=3 bash scripts/bench.sh    # all experiments, fewer trials

Results go to a new folder `benchmarks/<timestamp>/`; read its `RESULTS.md`.

## 6. Turn on the per-IP limit (optional)

    IP_RATE_LIMIT_CAPACITY=100 IP_RATE_LIMIT_REFILL_PER_SEC=1 docker compose up -d gateway-1 gateway-2

## 7. Stop

    docker compose down

## Other useful commands

| Command | What it does |
|---|---|
| `npm run build && npm start` | Run the compiled app without Docker (needs Redis and the `.env` values) |
| `npm run smoke` | Boot the compiled build and test it end to end (after `npm run build`) |
| `npm run audit` | Check dependencies for known vulnerabilities |
| `docker compose logs gateway-1` | See gateway logs |

## If something goes wrong

- **"Cannot connect to the Docker daemon" / docker errors:** start Docker Desktop and wait until it says running.
- **Tests fail with "Redis is required":** run `docker compose up -d redis`.
- **Port already in use (3001, 3002, 4001, 4002, 6379):** stop whatever else uses it, or run `docker compose down`.
- **`.dev/gateway.env` not found:** run `node scripts/dev-keys.mjs`.
- **Code changes not showing in Docker:** run `docker compose up -d --build` (it rebuilds both gateways).
- **Demo shows odd numbers on a re-take:** just run it again; each run starts from a clean Redis.

Settings are environment variables; see `.env.example`. Project overview: `README.md`.
