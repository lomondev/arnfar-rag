# .docx extractor sidecar — Python 3.12 + FastAPI + python-docx.
FROM python:3.12-slim

WORKDIR /app

# Legacy .doc → .docx needs LibreOffice. It's ~500MB, so it's opt-in:
#   docker compose build --build-arg INSTALL_LIBREOFFICE=true docx-extractor
# With it off, .doc uploads return a clear 422 and /health reports libreoffice:false.
ARG INSTALL_LIBREOFFICE=false
RUN if [ "$INSTALL_LIBREOFFICE" = "true" ]; then \
      apt-get update && \
      apt-get install -y --no-install-recommends libreoffice-writer && \
      rm -rf /var/lib/apt/lists/*; \
    fi

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

EXPOSE 7732

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:7732/health').status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "7732"]
