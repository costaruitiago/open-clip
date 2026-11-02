import json
import logging
import os
from pathlib import Path
from typing import Dict, Any, Optional

from backend.src.infrastructure.credentials import (
    LocalCredentialProvider,
    LocalUserSettingsProvider,
)

logger = logging.getLogger(__name__)

# Credentials and account identifiers. Never written to settings.json or
# user_settings.json; they live in secrets.json, which git ignores.
SECRET_KEYS = {
    "gemini_api_key",
    "youtube_client_secrets",
    "postiz_channels",
    "youtube_channel",
}

# Content that belongs to whoever runs the install: descriptions, copy
# templates, self-hosted service URLs. It lives in user_settings.json, which
# git ignores, so settings.json stays shareable. Application settings - theme,
# model, codec, log_level, pipeline and caption defaults - stay in
# settings.json.
USER_KEYS = {
    "description_defaults",
    "postiz_api_url",
    "postiz_text_template",
    "postiz_comment_template",
}

def is_secret_key(key: str) -> bool:
    return key in SECRET_KEYS or key.endswith("_key") or key.endswith("_secret") or key.endswith("_secrets")

def is_user_key(key: str) -> bool:
    """User-scoped keys. Checked after is_secret_key, which always wins."""
    if is_secret_key(key):
        return False
    return key in USER_KEYS or key.endswith("_url") or key.endswith("_template")

class SettingsManager:
    SETTINGS_PATH = Path("backend/config/settings.json")

    def __init__(self, config_path: str = None):
        """Initialize SettingsManager.
        The config_path argument is retained for backward compatibility but ignored.
        The actual path used is the class attribute SETTINGS_PATH
        """
        self.settings = self._initialize_and_load()

    def _get_credential_provider(self) -> LocalCredentialProvider:
        secrets_dir = str(self.SETTINGS_PATH.parent)
        return LocalCredentialProvider(secrets_dir=secrets_dir)

    def _get_user_settings_provider(self) -> LocalUserSettingsProvider:
        config_dir = str(self.SETTINGS_PATH.parent)
        return LocalUserSettingsProvider(config_dir=config_dir)

    def _initialize_and_load(self) -> Dict[str, Any]:
        """Load settings from the JSON file, creating defaults if missing."""
        path = self.SETTINGS_PATH
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            defaults = {
                "theme": "light",
                "log_level": "INFO",
                "pipeline_defaults": {},
                "video_defaults": {
                    "resolution": "keep original",
                    "aspect_ratio": "keep original",
                },
            }
            self._save_settings(defaults)
            user_defaults = {
                # Empty means "use the template and text the app ships with";
                # see backend/src/services/description_builder.py.
                "description_defaults": {
                    "text": "",
                    "template": "",
                },
            }
            self._get_user_settings_provider().save_all(user_defaults)
            return defaults
        return self._load_settings()

    def _load_settings(self) -> Dict[str, Any]:
        """Loads settings.json, migrating any secret or user keys out of it."""
        path = self.SETTINGS_PATH
        if not path.exists() or path.stat().st_size == 0:
            return {}
        try:
            with open(path, "r") as f:
                content = json.load(f)
                settings = content if isinstance(content, dict) else {}
        except json.JSONDecodeError as e:
            logger.error(f"Error loading settings from {path}: {e}")
            return {}
        except Exception as e:
            logger.error(f"Unexpected error loading settings from {path}: {e}")
            return {}

        migrated = False

        # Move any secret keys still sitting in settings.json into secrets.json.
        secrets_found = {k: v for k, v in settings.items() if is_secret_key(k)}
        if secrets_found:
            provider = self._get_credential_provider()
            existing_secrets = provider.load_all()
            for k, v in secrets_found.items():
                if k not in existing_secrets:
                    provider.save(k, v)
                del settings[k]
            migrated = True

        # Anything a user personalised stays in settings.json as the shipped
        # default; the user's own value is copied into user_settings.json once.
        user_found = {k: v for k, v in settings.items() if is_user_key(k)}
        if user_found:
            provider = self._get_user_settings_provider()
            existing_user = provider.load_all()
            new_values = {k: v for k, v in user_found.items() if k not in existing_user}
            if new_values:
                provider.save_all(new_values)

        if migrated:
            self._save_settings(settings)

        return settings

    def _save_settings(self, settings: Dict[str, Any]):
        """Saves shared, non-secret, non-user settings to settings.json."""
        path = self.SETTINGS_PATH
        # Filter out secret and user keys just in case
        clean_settings = {
            k: v for k, v in settings.items()
            if not is_secret_key(k) and not is_user_key(k)
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(path, "w") as f:
                json.dump(clean_settings, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving settings: {e}")

    def get(self, key: str, default: Any = None) -> Any:
        """Retrieves a setting, user preference or secret value."""
        if is_secret_key(key):
            val = self._get_credential_provider().load(key)
            return val if val is not None else default
        if is_user_key(key):
            val = self._get_user_settings_provider().load(key)
            if val is not None:
                return val
            # Fall back to the shipped default in settings.json.
            return self.settings.get(key, default)
        return self.settings.get(key, default)

    def set(self, key: str, value: Any):
        """Updates a setting, user preference or secret value and persists it."""
        if is_secret_key(key):
            self._get_credential_provider().save(key, value)
        elif is_user_key(key):
            self._get_user_settings_provider().save(key, value)
        else:
            self.settings[key] = value
            self._save_settings(self.settings)
            return

        if key in self.settings:
            del self.settings[key]
            self._save_settings(self.settings)

    def update_batch(self, updates: Dict[str, Any]):
        """Updates many settings at once, routing each key to its own file."""
        logger.info(f"update_batch called with updates: {updates.keys()}")
        secrets_dict = {}
        user_dict = {}
        shared_dict = {}
        for k, v in updates.items():
            if is_secret_key(k):
                secrets_dict[k] = v
            elif is_user_key(k):
                user_dict[k] = v
            else:
                shared_dict[k] = v

        if secrets_dict:
            self._get_credential_provider().save_all(secrets_dict)
        if user_dict:
            self._get_user_settings_provider().save_all(user_dict)
        for k in list(secrets_dict) + list(user_dict):
            self.settings.pop(k, None)

        if shared_dict:
            self.settings.update(shared_dict)

        logger.info(f"Saving settings to json: {self.settings.keys()}")
        self._save_settings(self.settings)

    def get_all(self) -> Dict[str, Any]:
        """Returns every setting: shared defaults, user overrides and secrets."""
        all_settings = self.settings.copy()
        all_settings.update(self._get_user_settings_provider().load_all())
        all_settings.update(self._get_credential_provider().load_all())
        return all_settings

    def get_settings_path(self) -> Path:
        """Utility for tests to retrieve the actual settings file path."""
        return self.SETTINGS_PATH

# Global instance used by the codebase
settings_manager = SettingsManager()
