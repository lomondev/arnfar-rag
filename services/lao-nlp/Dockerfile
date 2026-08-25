# Lao NLP sidecar — Python 3.12 + FastAPI (LaoNLP lands in Phase 1).
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Optional cross-encoder reranking (CLAUDE.md decision 4). Off by default — it adds ~2.5 GB
# and nothing on the ingest path needs it. `--build-arg WITH_RERANKER=1` installs torch +
# sentence-transformers AND bakes the weights into the image, so the running container
# never reaches for huggingface.co: no cloud call on the runtime path, and `docker compose
# up` works on a machine with no network.
ARG WITH_RERANKER=0
ARG RERANK_MODEL=BAAI/bge-reranker-v2-m3
ENV RERANK_MODEL=${RERANK_MODEL} \
    HF_HOME=/opt/hf \
    HF_HUB_OFFLINE=1
COPY requirements-rerank.txt ./
RUN if [ "$WITH_RERANKER" = "1" ]; then \
      pip install --no-cache-dir -r requirements-rerank.txt && \
      HF_HUB_OFFLINE=0 python -c "import os; from sentence_transformers import CrossEncoder; CrossEncoder(os.environ['RERANK_MODEL'])"; \
    fi

COPY app ./app

EXPOSE 7731

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:7731/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7731"]
