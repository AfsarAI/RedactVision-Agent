"""
RedactVision Agent - Server-side reasoning module.

Privacy contract: The server NEVER receives the local token map or
raw PII. It only receives sanitized DOM context with semantic tokens
(e.g. [EMAIL_01]) and non-sensitive metadata.
"""