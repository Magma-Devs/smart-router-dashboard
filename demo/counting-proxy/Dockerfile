# Counting proxy — stdlib-only, so no pip step and no lockfile to drift.
FROM python:3.12-alpine

WORKDIR /app
COPY proxy.py /app/proxy.py

EXPOSE 8899
HEALTHCHECK --interval=5s --timeout=3s --retries=5 --start-period=3s \
    # 127.0.0.1, NOT localhost: busybox resolves localhost to ::1 first and
    # ThreadingHTTPServer binds IPv4 only, so "localhost" is refused.
    CMD wget -qO- http://127.0.0.1:8899/__stats >/dev/null || exit 1

CMD ["python", "-u", "/app/proxy.py"]
