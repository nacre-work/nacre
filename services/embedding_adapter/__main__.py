"""Entry point: python -m services.embedding_adapter"""

from services.embedding_adapter.app import serve

if __name__ == "__main__":
    serve()
