use std::{borrow::Cow, collections::HashMap};

use serde::{Deserialize, Serialize};

/// A function to be injected into the context.
#[derive(Debug, Clone, Serialize)]
pub struct FunctionDef {
    /// The name of the function
    pub name: Cow<'static, str>,
    /// The function's parameters
    pub params: Vec<String>,
    /// The function's code
    pub code: Cow<'static, str>,
}

/// A ES Module to be importable by the script
#[derive(Debug, Clone, Serialize)]
pub struct CodeModule {
    /// The name of the module, as it should appear in import statements.
    pub name: Cow<'static, str>,
    /// The JavaScript code of the model.
    pub code: Cow<'static, str>,
}

/// Data associated with the RunScript message
#[derive(Debug, Clone, Serialize)]
pub struct RunScriptArgs {
    pub name: Cow<'static, str>,

    /// The code to run. This can be omitted if the message is just initializing the context for later runs.
    pub code: Option<Cow<'static, str>>,

    /// Recreate the run context instead of reusing the context from the previous run on this connection.
    pub recreate_context: bool,

    /// If true, the code is just a simple expression and should run on its own.
    /// Expression mode supports returning a value directly, but does not support specifying `modules`.
    pub expr: bool,

    /// Global variables to set in the context.
    pub globals: Option<HashMap<String, serde_json::Value>>,

    /// How long to wait for the script to complete.
    pub timeout_ms: Option<u64>,

    /// Functions to compile and place in the global scope
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub functions: Vec<FunctionDef>,

    /// ES Modules to make available for the code to import.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<CodeModule>,

    /// If set, return only these keys from the context. If omitted, the entire global context is returned.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub return_keys: Vec<String>,
}

impl Default for RunScriptArgs {
    fn default() -> Self {
        Self {
            name: Default::default(),
            code: Default::default(),
            recreate_context: false,
            expr: false,
            globals: Default::default(),
            timeout_ms: Default::default(),
            functions: Default::default(),
            modules: Default::default(),
            return_keys: Default::default(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RunResponseData {
    #[serde(default)]
    pub globals: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub return_value: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ErrorResponseData {
    pub message: String,
    pub stack: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LogResponseData {
    pub level: String,
    pub data: serde_json::Value,
}
