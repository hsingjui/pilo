use nsh_core::element::{Function, FunctionCall, JsHost, Module, TaskStart, Thrown};

#[cfg(windows)]
mod windows;

pub(crate) struct DesktopUpdates;

impl Module for DesktopUpdates {
    const NAME: &'static str = "DesktopUpdates";
    const DOC: &'static str = "The desktop updater with the platform's proxy settings.";
    const FUNCTIONS: &'static [Function] = &[Function {
        name: "checkForUpdate",
        doc: "Checks for a signed app update using the Windows system proxy on Windows.",
        params: &[(
            "options",
            |_| "import(\"nsh/updater\").UpdateCheckOptions | null".into(),
            true,
        )],
        returns: Some(|_| "import(\"nsh/updater\").AppUpdate | null".into()),
        refs: |_| {},
        call: FunctionCall::Start(check_for_update),
        getter: false,
        overloads: &[],
    }];
}

fn check_for_update(host: &dyn JsHost) -> Result<TaskStart, Thrown> {
    let start = nsh_core::runtime::registries()
        .iter()
        .find(|registry| registry.namespace() == Some("nsh/updater"))
        .and_then(|registry| {
            registry.module_specs().iter().find_map(|module| {
                module
                    .functions
                    .iter()
                    .find_map(|function| match function.call {
                        FunctionCall::Start(start) if function.name == "checkForUpdate" => {
                            Some(start)
                        }
                        _ => None,
                    })
            })
        })
        .ok_or("nsh checkForUpdate is unavailable")?;
    // nsh retains the host from checkForUpdate for downloadUpdate. Give it the
    // Windows transport here, without changing its verification or install state.
    #[cfg(windows)]
    let host = &windows::UpdateCall(host);
    start(host)
}
