# Helpers for the Compose quickstart. The compose file alone is the
# product — `docker compose up -d` needs nothing here — but anyone who wants
# to keep the instance should replace its public fixtures first.
#
#   make quickstart   # rewrite every fixture secret with `openssl rand`, then `docker compose up -d`
#   make secrets      # only the rewrite
#   make reset        # stop and delete the data volume (a fresh database next time)
#
# `secrets` must run BEFORE the first `up`: Postgres sets its password when
# it initialises the volume, and the server's API_KEY_ENCRYPTION_KEY
# encrypts scanner keys at rest from the first boot. On an instance that
# has already started, `make reset` first (losing its data), or change the
# database password in Postgres yourself and edit the URLs by hand.

COMPOSE_FILE ?= docker-compose.yml

# Every fixture is a unique literal that appears in the file one or more
# times (the database password is in three places); each is replaced
# everywhere by one generated value. Hex and base64url are URL-safe, so the
# DATABASE_URLs stay valid. The admin password is left as `admin` on
# purpose: the first login forces a change.
FIXTURE_DB_PASSWORD   := stackradar-fixture-db-password
FIXTURE_INTERNAL_KEY  := stackradar-fixture-internal-service-key
FIXTURE_ENCRYPTION    := 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
FIXTURE_SCANNER_KEY   := stackradar-fixture-bootstrap-scanner-key
FIXTURE_AUTH_SECRET   := stackradar-fixture-auth-secret-change-me
FIXTURE_CLUSTER_ID    := 8f6b0b7a-0c1e-4f6e-9a4b-2f3d1c0e5a71

.PHONY: quickstart secrets up down reset check-fixtures

quickstart: secrets up

up:
	docker compose -f $(COMPOSE_FILE) up -d

down:
	docker compose -f $(COMPOSE_FILE) down

reset:
	docker compose -f $(COMPOSE_FILE) down --volumes

# Refuses to run twice: a file without the fixtures has nothing to rotate,
# and running the replacement over generated values would be a silent no-op
# that looked like success.
check-fixtures:
	@grep -q '$(FIXTURE_DB_PASSWORD)' $(COMPOSE_FILE) || { echo "no fixtures left in $(COMPOSE_FILE); already rotated"; exit 1; }

secrets: check-fixtures
	@command -v openssl >/dev/null || { echo "openssl is required"; exit 1; }
	@set -e; \
	db="$$(openssl rand -hex 24)"; \
	internal="$$(openssl rand -hex 32)"; \
	enc="$$(openssl rand -hex 32)"; \
	scanner="$$(openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n')"; \
	auth="$$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"; \
	cluster="$$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z' || cat /proc/sys/kernel/random/uuid)"; \
	sed -i.bak \
	  -e "s|$(FIXTURE_DB_PASSWORD)|$$db|g" \
	  -e "s|$(FIXTURE_INTERNAL_KEY)|$$internal|g" \
	  -e "s|$(FIXTURE_ENCRYPTION)|$$enc|g" \
	  -e "s|$(FIXTURE_SCANNER_KEY)|$$scanner|g" \
	  -e "s|$(FIXTURE_AUTH_SECRET)|$$auth|g" \
	  -e "s|$(FIXTURE_CLUSTER_ID)|$$cluster|g" \
	  $(COMPOSE_FILE); \
	rm -f $(COMPOSE_FILE).bak; \
	echo "Rewrote the fixture secrets in $(COMPOSE_FILE)."; \
	echo "Scanner/upload key (BOOTSTRAP_CLUSTER_API_KEY): $$scanner"; \
	echo "The admin password is still 'admin'; the first login replaces it."
