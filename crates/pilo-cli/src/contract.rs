//! Checks request parameters against the generated Host method bindings.

use serde_json::{Map, Value};

pub struct Method {
    pub name: &'static str,
    pub params: &'static [Param],
}

pub struct Param {
    pub name: &'static str,
    pub ty: &'static str,
    pub optional: bool,
}

impl Method {
    /// Builds the params object, rejecting keys the Host does not declare and
    /// missing required keys; `null` values are dropped.
    pub fn params(&self, fields: &[(&str, Value)]) -> Result<Value, String> {
        let mut params = Map::new();
        for (key, value) in fields {
            if !self.params.iter().any(|param| param.name == *key) {
                return Err(format!("{} has no parameter '{key}'", self.name));
            }
            if !value.is_null() {
                params.insert((*key).to_owned(), value.clone());
            }
        }
        if let Some(missing) = self
            .params
            .iter()
            .find(|param| !param.optional && !params.contains_key(param.name))
        {
            return Err(format!(
                "{} requires parameter '{}' ({})",
                self.name, missing.name, missing.ty
            ));
        }
        Ok(Value::Object(params))
    }
}
