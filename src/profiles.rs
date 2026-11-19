use crate::store::Group;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;

#[allow(dead_code)]
const DEEPSEEK_API_ADAPTER: &str = "";

#[derive(Clone, Deserialize, Serialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub models: Vec<String>,
    #[serde(default)]
    pub instruction: String,
    #[serde(default)]
    pub model_family: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<ProfileMetadata>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct ProfileMetadata {
    pub source_url: String,
    pub source_revision: String,
    pub variant: String,
    pub validation: String,
}

#[derive(Deserialize, Serialize)]
pub struct ProfileTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub source_revision: String,
    #[serde(default)]
    pub validation: String,
}

pub fn templates() -> &'static [ProfileTemplate] {
    &[]
}

pub fn template_instruction_by_id(_template_id: &str, _model: &str) -> Option<&'static str> {
    None
}

pub fn default_instruction_text() -> &'static str {
    DEFAULT_INSTRUCTION
}

pub fn template_raw_instruction(template_id: &str) -> Option<&'static str> {
    if template_id == "default" && !DEFAULT_INSTRUCTION.is_empty() {
        return Some(DEFAULT_INSTRUCTION);
    }
    None
}

pub fn model_family(model: &str) -> Option<&'static str> {
    [
        "gpt-5.6", "gpt-6.1", "gpt-6", "claude", "grok", "gemini", "deepseek", "glm", "kimi",
    ]
    .into_iter()
    .find(|family| {
        model == *family
            || model
                .strip_prefix(*family)
                .is_some_and(|suffix| suffix.starts_with('-'))
    })
}

pub fn all() -> &'static [Profile] {
    &[]
}

pub fn find(_id: &str) -> Option<Cow<'static, Profile>> {
    None
}

pub(crate) fn legacy_profile(_models: &[String], _instruction: &str) -> Option<&'static Profile> {
    None
}

pub fn instruction(_group: &Group, _model: &str) -> Option<&'static str> {
    None
}

/// Opt-in fallback, applied only when non-empty and no custom prompt overrides it.
pub const DEFAULT_INSTRUCTION: &str = "";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_profiles_and_templates_are_empty() {
        assert!(templates().is_empty());
        assert!(all().is_empty());
        assert!(DEFAULT_INSTRUCTION.is_empty());
        assert!(find("default").is_none());
        assert!(legacy_profile(&["gpt-6".into()], "test").is_none());
        assert!(template_instruction_by_id("default", "gpt-6").is_none());
        let fallback = Group {
            default_strategy_enabled: true,
            ..Default::default()
        };
        assert!(instruction(&fallback, "gpt-6").is_none());
    }

    #[test]
    fn families_have_exact_or_hyphen_boundaries() {
        for (model, expected) in [
            ("gpt-5.6", Some("gpt-5.6")),
            ("gpt-5.6-sol", Some("gpt-5.6")),
            ("gpt-6", Some("gpt-6")),
            ("gpt-6-astra", Some("gpt-6")),
            ("gpt-6-sol", Some("gpt-6")),
            ("gpt-6.1", Some("gpt-6.1")),
            ("gpt-6.1-sol", Some("gpt-6.1")),
            ("gpt-6.10-sol", None),
            ("gpt-60", None),
            ("gpt-5.60-sol", None),
            ("other-gpt-6", None),
            ("GPT-6", None),
            ("claude-opus-5-5", Some("claude")),
            ("grok-4.7", Some("grok")),
            ("grok-4.6", Some("grok")),
            ("grok-build", Some("grok")),
            ("gemini-3.1-pro-preview", Some("gemini")),
            ("deepseek-v4.1-flash", Some("deepseek")),
            ("glm-5.3", Some("glm")),
            ("glm-5.3-flash", Some("glm")),
            ("glm-5.3-air", Some("glm")),
            ("kimi-k2.7-code", Some("kimi")),
            ("kimilike-k3", None),
            ("claudelike-5", None),
            ("grokish", None),
            ("Gemini-3.1-pro", None),
        ] {
            assert_eq!(model_family(model), expected, "{model}");
        }
    }
}
