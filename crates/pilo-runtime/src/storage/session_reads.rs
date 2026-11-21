use rusqlite::{Connection as SqliteConnection, Transaction, TransactionBehavior, params};

use pilo_domain::SessionReadState;

fn read_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionReadState> {
    Ok(SessionReadState {
        project_id: row.get(0)?,
        session_path: row.get(1)?,
        completed_revision: row.get(2)?,
        read_revision: row.get(3)?,
    })
}

pub(crate) fn list_session_read_states(
    db: &SqliteConnection,
) -> Result<Vec<SessionReadState>, String> {
    let mut statement = db
        .prepare("SELECT project_id,session_path,completed_revision,read_revision FROM session_read_state")
        .map_err(|error| format!("failed to list session read states: {error}"))?;
    statement
        .query_map([], read_state)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(crate) fn complete_session_turn(
    db: &SqliteConnection,
    project_id: &str,
    session_path: &str,
) -> Result<SessionReadState, String> {
    let transaction = Transaction::new_unchecked(db, TransactionBehavior::Immediate)
        .map_err(|error| format!("failed to begin session completion transaction: {error}"))?;
    // Revisions survive deletion/recreation of a project or indexed session.
    let revision: u64 = transaction
        .query_row(
            "UPDATE session_read_revision SET revision=revision+1 WHERE id=1 RETURNING revision",
            [],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to allocate session read revision: {error}"))?;
    let state = transaction.query_row(
        "INSERT INTO session_read_state(project_id,session_path,completed_revision,read_revision)
         VALUES(?1,?2,?3,0)
         ON CONFLICT(project_id,session_path) DO UPDATE
         SET completed_revision=excluded.completed_revision
         RETURNING project_id,session_path,completed_revision,read_revision",
        params![project_id, session_path, revision],
        read_state,
    )
    .map_err(|error| format!("failed to record completed session turn: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit completed session turn: {error}"))?;
    Ok(state)
}

pub(crate) fn mark_session_read(
    db: &SqliteConnection,
    project_id: &str,
    session_path: &str,
    revision: u64,
) -> Result<SessionReadState, String> {
    // Acknowledge only the observed turn, never a newer completion.
    db.query_row(
        "UPDATE session_read_state
         SET read_revision=MAX(read_revision,MIN(?3,completed_revision))
         WHERE project_id=?1 AND session_path=?2
         RETURNING project_id,session_path,completed_revision,read_revision",
        params![project_id, session_path, revision],
        read_state,
    )
    .map_err(|error| format!("failed to mark session read: {error}"))
}
