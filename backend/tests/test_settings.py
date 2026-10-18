import os
import json
import tempfile
import pytest
from pathlib import Path

from backend.src.settings_manager import SettingsManager, is_secret_key, is_user_key
from backend.src.infrastructure.credentials import LocalCredentialProvider

def test_is_secret_key():
    assert is_secret_key("gemini_api_key") is True
    assert is_secret_key("youtube_client_secrets") is True
    assert is_secret_key("some_other_secret") is True
    assert is_secret_key("postiz_channels") is True
    assert is_secret_key("theme") is False
    assert is_secret_key("log_level") is False

def test_is_user_key():
    assert is_user_key("description_defaults") is True
    assert is_user_key("postiz_api_url") is True
    assert is_user_key("postiz_text_template") is True
    # Application settings stay in settings.json.
    assert is_user_key("theme") is False
    assert is_user_key("codec") is False
    assert is_user_key("model") is False
    assert is_user_key("log_level") is False
    assert is_user_key("postiz_per_day") is False
    assert is_user_key("pipeline_defaults") is False
    assert is_user_key("caption_defaults") is False
    # Secrets always win over the user-key heuristics.
    assert is_user_key("postiz_api_key") is False

def _manager_in(config_dir: Path) -> SettingsManager:
    manager = SettingsManager()
    manager.SETTINGS_PATH = config_dir / "settings.json"
    manager.settings = manager._initialize_and_load()
    return manager

def test_settings_manager_separates_secrets_settings_and_user_prefs():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_dir = Path(tmpdir)
        settings_file = config_dir / "settings.json"
        secrets_file = config_dir / "secrets.json"
        user_file = config_dir / "user_settings.json"

        manager = _manager_in(config_dir)

        manager.update_batch({
            "theme": "dark",
            "log_level": "DEBUG",
            "caption_defaults": {"enabled": True},
            "postiz_api_url": "https://postiz.example.com/",
            "description_defaults": {"text": "my links"},
            "gemini_api_key": "TEST_GEMINI_KEY_123",
            "youtube_client_secrets": {"installed": {"client_id": "test_id"}},
        })

        # settings.json keeps the application settings.
        with open(settings_file, "r") as f:
            settings_json = json.load(f)
        assert settings_json["theme"] == "dark"
        assert settings_json["log_level"] == "DEBUG"
        assert settings_json["caption_defaults"] == {"enabled": True}
        for key in ("postiz_api_url", "description_defaults", "gemini_api_key", "youtube_client_secrets"):
            assert key not in settings_json

        # secrets.json keeps the credentials.
        with open(secrets_file, "r") as f:
            secrets_json = json.load(f)
        assert secrets_json["gemini_api_key"] == "TEST_GEMINI_KEY_123"
        assert secrets_json["youtube_client_secrets"] == {"installed": {"client_id": "test_id"}}
        assert "theme" not in secrets_json

        # user_settings.json keeps the personal content.
        with open(user_file, "r") as f:
            user_json = json.load(f)
        assert user_json["postiz_api_url"] == "https://postiz.example.com/"
        assert user_json["description_defaults"] == {"text": "my links"}
        assert "theme" not in user_json
        assert "gemini_api_key" not in user_json

        # get() reads from whichever file owns the key.
        assert manager.get("theme") == "dark"
        assert manager.get("postiz_api_url") == "https://postiz.example.com/"
        assert manager.get("gemini_api_key") == "TEST_GEMINI_KEY_123"

        # get_all() combines all three.
        all_settings = manager.get_all()
        assert all_settings["theme"] == "dark"
        assert all_settings["postiz_api_url"] == "https://postiz.example.com/"
        assert all_settings["gemini_api_key"] == "TEST_GEMINI_KEY_123"

def test_set_routes_each_key_to_its_own_file():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_dir = Path(tmpdir)
        manager = _manager_in(config_dir)

        manager.set("codec", "libx264")
        manager.set("postiz_comment_template", "watch here: {project.source_url}")
        manager.set("postiz_api_key", "pk-secret")

        with open(config_dir / "settings.json", "r") as f:
            assert json.load(f)["codec"] == "libx264"
        with open(config_dir / "user_settings.json", "r") as f:
            assert json.load(f)["postiz_comment_template"] == "watch here: {project.source_url}"
        with open(config_dir / "secrets.json", "r") as f:
            assert json.load(f)["postiz_api_key"] == "pk-secret"

        assert manager.get("postiz_comment_template") == "watch here: {project.source_url}"
        assert manager.get("postiz_api_key") == "pk-secret"


def test_jev_key_is_a_secret_and_its_url_is_a_user_setting():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_dir = Path(tmpdir)
        manager = _manager_in(config_dir)

        manager.set("typesafe_api_key", "ts-secret")
        manager.set("typesafe_api_url", "https://gateway.example.com")

        with open(config_dir / "secrets.json", "r") as f:
            assert json.load(f)["typesafe_api_key"] == "ts-secret"
        with open(config_dir / "user_settings.json", "r") as f:
            assert json.load(f)["typesafe_api_url"] == "https://gateway.example.com"
        assert manager.get("typesafe_api_key") == "ts-secret"

def test_settings_manager_migrates_existing_secrets_from_settings_json():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_dir = Path(tmpdir)
        settings_file = config_dir / "settings.json"
        secrets_file = config_dir / "secrets.json"

        # Manually create settings.json with a secret in it
        initial_settings = {
            "caption_defaults": {"enabled": True},
            "gemini_api_key": "LEGACY_SECRET_KEY"
        }
        with open(settings_file, "w") as f:
            json.dump(initial_settings, f)

        manager = _manager_in(config_dir)

        # Check that secret was removed from settings.json
        with open(settings_file, "r") as f:
            clean_settings = json.load(f)
        assert "gemini_api_key" not in clean_settings
        assert clean_settings["caption_defaults"] == {"enabled": True}

        # Check that secret was migrated to secrets.json
        with open(secrets_file, "r") as f:
            migrated_secrets = json.load(f)
        assert migrated_secrets["gemini_api_key"] == "LEGACY_SECRET_KEY"

def test_settings_manager_copies_user_keys_out_of_settings_json():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_dir = Path(tmpdir)
        settings_file = config_dir / "settings.json"
        user_file = config_dir / "user_settings.json"

        # A legacy settings.json still carrying the user's own content.
        with open(settings_file, "w") as f:
            json.dump({
                "theme": "dark",
                "postiz_api_url": "https://mine.example/",
                "description_defaults": {"text": "my links"},
            }, f)

        manager = _manager_in(config_dir)

        with open(user_file, "r") as f:
            user_json = json.load(f)
        assert user_json["postiz_api_url"] == "https://mine.example/"
        assert user_json["description_defaults"] == {"text": "my links"}
        assert "theme" not in user_json
        assert manager.get("postiz_api_url") == "https://mine.example/"
        assert manager.get("theme") == "dark"

def test_settings_json_value_is_the_default_when_user_has_none():
    with tempfile.TemporaryDirectory() as tmpdir:
        config_dir = Path(tmpdir)
        settings_file = config_dir / "settings.json"

        with open(settings_file, "w") as f:
            json.dump({"postiz_text_template": "{platform.post}\n"}, f)
        with open(config_dir / "user_settings.json", "w") as f:
            json.dump({"postiz_api_url": "https://mine.example/"}, f)

        manager = _manager_in(config_dir)

        # postiz_text_template has no user override, so the shipped default applies.
        assert manager.get("postiz_text_template") == "{platform.post}\n"
        assert manager.get("postiz_api_url") == "https://mine.example/"
        assert manager.get("postiz_comment_template", "fallback") == "fallback"
