.PHONY: up down logs build restart ps

up:
	docker compose up --build -d
	@echo "\n✅ Running at:"
	@echo "  Frontend:  http://localhost:3000"
	@echo "  Chatbot:   http://localhost:3001"
	@echo "  Ingestion: http://localhost:4000"
	@echo "  Metrics:   http://localhost:4000/metrics"

down:
	docker compose down

logs:
	docker compose logs -f

build:
	docker compose build

restart:
	docker compose restart

ps:
	docker compose ps
