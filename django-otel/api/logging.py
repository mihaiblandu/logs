import logging

from opentelemetry import baggage


class ContextLogFilter(logging.Filter):
    """Copies request.id / user.id from baggage onto every log record -> OTel log attributes."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key in ("request.id", "user.id"):
            value = baggage.get_baggage(key)
            if value is not None and not hasattr(record, key):
                setattr(record, key, value)
        return True
