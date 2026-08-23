import json
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .prompt_writer_config import DATA_DIR


DATABASE_PATH = DATA_DIR / "conversations.db"
_DEFAULT_PARENT = object()


class _ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


def _now():
    return datetime.now(UTC).isoformat()


def _json(value, fallback):
    try:
        result = json.loads(value) if value else fallback
        return result if isinstance(result, type(fallback)) else fallback
    except json.JSONDecodeError:
        return fallback


class PromptWriterStore:
    def __init__(self, path=DATABASE_PATH):
        self.path = Path(path)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self):
        connection = sqlite3.connect(self.path, factory=_ClosingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY,
                    scheduler_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    provider TEXT,
                    model TEXT,
                    active_leaf_id TEXT,
                    archived_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    parent_id TEXT,
                    revision_root_id TEXT NOT NULL,
                    revision_index INTEGER NOT NULL DEFAULT 0,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'complete',
                    provider TEXT,
                    model TEXT,
                    metadata TEXT NOT NULL DEFAULT '{}',
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS prompt_writer_conversations_scheduler
                    ON conversations(scheduler_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS prompt_writer_messages_conversation
                    ON messages(conversation_id, created_at);
                CREATE INDEX IF NOT EXISTS prompt_writer_message_revisions
                    ON messages(conversation_id, revision_root_id, revision_index);
                """
            )

    def create_conversation(self, scheduler_id, provider, model, conversation_id=None):
        identifier = conversation_id or str(uuid.uuid4())
        now = _now()
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO conversations
                    (id, scheduler_id, title, provider, model, created_at, updated_at)
                VALUES (?, ?, 'New chat', ?, ?, ?, ?)
                """,
                (identifier, scheduler_id, provider, model, now, now),
            )
        return self.get_conversation(identifier)

    def ensure_conversation(self, conversation_id, scheduler_id, provider, model):
        conversation = self.get_conversation(conversation_id)
        if conversation:
            if conversation["schedulerId"] != scheduler_id:
                raise ValueError("This conversation belongs to a different Beat Prompt Scheduler.")
            if conversation["archivedAt"]:
                raise ValueError("Restore this conversation before continuing it.")
            self.update_conversation(conversation_id, provider=provider, model=model)
            return self.get_conversation(conversation_id)
        return self.create_conversation(scheduler_id, provider, model, conversation_id)

    def list_conversations(self, scheduler_id, archived=False, limit=100):
        archived_clause = "archived_at IS NOT NULL" if archived else "archived_at IS NULL"
        with self._connect() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM conversations
                WHERE scheduler_id = ? AND {archived_clause}
                ORDER BY updated_at DESC LIMIT ?
                """,
                (scheduler_id, max(1, min(int(limit), 500))),
            ).fetchall()
        return [self._conversation(row) for row in rows]

    def get_conversation(self, conversation_id):
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
        return self._conversation(row) if row else None

    def update_conversation(self, conversation_id, **changes):
        mapping = {
            "title": "title",
            "provider": "provider",
            "model": "model",
            "archived_at": "archived_at",
            "active_leaf_id": "active_leaf_id",
        }
        fields = []
        values = []
        for key, column in mapping.items():
            if key in changes:
                fields.append(f"{column} = ?")
                values.append(changes[key])
        if not fields:
            return self.get_conversation(conversation_id)
        fields.append("updated_at = ?")
        values.extend((_now(), conversation_id))
        with self._lock, self._connect() as connection:
            result = connection.execute(
                f"UPDATE conversations SET {', '.join(fields)} WHERE id = ?",
                values,
            )
        return self.get_conversation(conversation_id) if result.rowcount else None

    def archive_conversation(self, conversation_id, archived):
        return self.update_conversation(
            conversation_id,
            archived_at=_now() if archived else None,
        )

    def delete_conversation(self, conversation_id):
        with self._lock, self._connect() as connection:
            return connection.execute(
                "DELETE FROM conversations WHERE id = ? AND archived_at IS NOT NULL",
                (conversation_id,),
            ).rowcount > 0

    def append_message(
        self,
        conversation_id,
        role,
        content,
        *,
        provider=None,
        model=None,
        metadata=None,
        status="complete",
        parent_id=_DEFAULT_PARENT,
        revision_root_id=None,
        revision_index=None,
    ):
        identifier = str(uuid.uuid4())
        now = _now()
        with self._lock, self._connect() as connection:
            conversation = connection.execute(
                "SELECT active_leaf_id FROM conversations WHERE id = ?",
                (conversation_id,),
            ).fetchone()
            if not conversation:
                raise ValueError("Conversation was not found.")
            if parent_id is _DEFAULT_PARENT:
                parent_id = conversation["active_leaf_id"]
            root_id = revision_root_id or identifier
            index = 0 if revision_index is None else int(revision_index)
            connection.execute(
                """
                INSERT INTO messages
                    (id, conversation_id, parent_id, revision_root_id, revision_index,
                     role, content, status, provider, model, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    conversation_id,
                    parent_id,
                    root_id,
                    index,
                    role,
                    content,
                    status,
                    provider,
                    model,
                    json.dumps(metadata or {}, ensure_ascii=False),
                    now,
                ),
            )
            connection.execute(
                "UPDATE conversations SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
                (identifier, now, conversation_id),
            )
        return self.get_message(identifier)

    def get_message(self, message_id):
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM messages WHERE id = ?", (message_id,)).fetchone()
        return self._message(row) if row else None

    def update_message_metadata(self, message_id, changes):
        message = self.get_message(message_id)
        if not message:
            return None
        metadata = message["metadata"]
        metadata.update(changes)
        with self._lock, self._connect() as connection:
            connection.execute(
                "UPDATE messages SET metadata = ? WHERE id = ?",
                (json.dumps(metadata, ensure_ascii=False), message_id),
            )
        return self.get_message(message_id)

    def list_messages(self, conversation_id, limit=500):
        conversation = self.get_conversation(conversation_id)
        if not conversation or not conversation["activeLeafId"]:
            return []
        with self._connect() as connection:
            rows = connection.execute(
                """
                WITH RECURSIVE branch(id, parent_id, depth) AS (
                    SELECT id, parent_id, 0 FROM messages WHERE id = ? AND conversation_id = ?
                    UNION ALL
                    SELECT messages.id, messages.parent_id, branch.depth + 1
                    FROM messages JOIN branch ON messages.id = branch.parent_id
                )
                SELECT messages.* FROM messages JOIN branch ON messages.id = branch.id
                ORDER BY branch.depth DESC LIMIT ?
                """,
                (conversation["activeLeafId"], conversation_id, max(1, min(int(limit), 1000))),
            ).fetchall()
            result = [self._message(row) for row in rows]
            for message in result:
                siblings = connection.execute(
                    """
                    SELECT id FROM messages
                    WHERE conversation_id = ? AND revision_root_id = ?
                    ORDER BY revision_index
                    """,
                    (conversation_id, message["revision"]["rootId"]),
                ).fetchall()
                ids = [row["id"] for row in siblings]
                message["revision"].update({
                    "count": len(ids),
                    "position": ids.index(message["id"]) + 1 if message["id"] in ids else 1,
                })
        return result

    def revise_user_message(
        self,
        conversation_id,
        message_id,
        content,
        provider,
        model,
        metadata=None,
    ):
        source = self.get_message(message_id)
        if not source or source["conversationId"] != conversation_id or source["role"] != "user":
            raise ValueError("The message to edit was not found in this conversation.")
        with self._connect() as connection:
            next_index = connection.execute(
                """
                SELECT COALESCE(MAX(revision_index), -1) + 1 AS value FROM messages
                WHERE conversation_id = ? AND revision_root_id = ?
                """,
                (conversation_id, source["revision"]["rootId"]),
            ).fetchone()["value"]
        return self.append_message(
            conversation_id,
            "user",
            content,
            provider=provider,
            model=model,
            metadata=metadata,
            parent_id=source["parentId"],
            revision_root_id=source["revision"]["rootId"],
            revision_index=next_index,
        )

    def select_message_version(self, conversation_id, message_id, direction):
        source = self.get_message(message_id)
        if not source or source["conversationId"] != conversation_id:
            raise ValueError("Message version was not found.")
        with self._lock, self._connect() as connection:
            siblings = connection.execute(
                """
                SELECT id FROM messages WHERE conversation_id = ? AND revision_root_id = ?
                ORDER BY revision_index
                """,
                (conversation_id, source["revision"]["rootId"]),
            ).fetchall()
            ids = [row["id"] for row in siblings]
            position = ids.index(message_id)
            target_position = max(0, min(len(ids) - 1, position + (1 if direction == "next" else -1)))
            leaf_id = ids[target_position]
            while True:
                child = connection.execute(
                    """
                    SELECT id FROM messages WHERE conversation_id = ? AND parent_id = ?
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (conversation_id, leaf_id),
                ).fetchone()
                if not child:
                    break
                leaf_id = child["id"]
            connection.execute(
                "UPDATE conversations SET active_leaf_id = ?, updated_at = ? WHERE id = ?",
                (leaf_id, _now(), conversation_id),
            )
        return self.list_messages(conversation_id)

    @staticmethod
    def _conversation(row):
        return {
            "id": row["id"],
            "schedulerId": row["scheduler_id"],
            "title": row["title"],
            "provider": row["provider"],
            "model": row["model"],
            "activeLeafId": row["active_leaf_id"],
            "archivedAt": row["archived_at"],
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    @staticmethod
    def _message(row):
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "parentId": row["parent_id"],
            "role": row["role"],
            "content": row["content"],
            "status": row["status"],
            "provider": row["provider"],
            "model": row["model"],
            "metadata": _json(row["metadata"], {}),
            "createdAt": row["created_at"],
            "revision": {
                "rootId": row["revision_root_id"],
                "index": row["revision_index"],
            },
        }


prompt_writer_store = PromptWriterStore()
