"""Run the Flux runtime UI server: `python -m flux_runtime`.

Port 8430 (leaves 8420 free for the Flux-Insight Dashboard backend).
"""
import uvicorn


def main() -> None:
    uvicorn.run("flux_runtime.server:app", host="127.0.0.1", port=8430, reload=False)


if __name__ == "__main__":
    main()
