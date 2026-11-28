//! Bot registry: one `bots/<botId>.json` per bot (`BotProfile`), loaded at start; the main bot
//! GOAT is created on first start (decision 2026-11-28).
//!
//! Lifted from GOAT v1 (goat origin/dev 916b5ccc1b2) `channels/ChannelBotProfiles.ts` (profile
//! fields, update keeps unspecified fields) and `ChannelBotHome.ts` (one main bot). Moved here
//! unchanged from `core/commands.rs` (lane E agreed the boundary).

use std::sync::Arc;

use goat2_contracts::{
    BotFace, BotId, BotProfile, BotRole, ModelSelection, ProviderInstanceId, ThreadKind,
};

use crate::api::CardUpdate;
use crate::core::Host;
use crate::core::commands::{
    DEFAULT_CODEX_MODEL, DEFAULT_RUNTIME_MODE, NewThread, create_thread, engine_config,
};
use crate::store::StoreError;
use crate::util::new_id;

/// The bot folder (`<dataDir>/bots/<botId>/`: notes, session record).
pub fn bot_dir(data_dir: &std::path::Path, bot_id: &BotId) -> std::path::PathBuf {
    data_dir.join("bots").join(bot_id.as_str())
}

fn bots_dir(host: &Host) -> std::path::PathBuf {
    host.options().data_dir.join("bots")
}

pub(crate) fn save_bot(host: &Host, profile: &BotProfile) -> Result<(), StoreError> {
    let dir = bots_dir(host);
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{}.json.tmp", profile.bot_id));
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(profile).map_err(std::io::Error::other)?,
    )?;
    std::fs::rename(tmp, dir.join(format!("{}.json", profile.bot_id)))?;
    Ok(())
}

pub(crate) fn create_bot(
    host: &Host,
    name: String,
    purpose: String,
    face: BotFace,
    model_selection: ModelSelection,
    role: BotRole,
) -> Result<BotProfile, StoreError> {
    let bot_id = if role == BotRole::Main {
        BotId::new("goat")
    } else {
        BotId::new(new_id("bot"))
    };
    let card = create_thread(
        host,
        None,
        NewThread {
            kind: ThreadKind::Bot,
            title: name.clone(),
            bot_id: Some(bot_id.clone()),
            parent: None,
            engine: engine_config(
                &model_selection,
                DEFAULT_RUNTIME_MODE,
                host.options().default_cwd.clone(),
            ),
        },
    )?;
    let profile = BotProfile {
        bot_id,
        name,
        purpose,
        face,
        role,
        session_thread_id: card.id,
        default_model_selection: model_selection,
        instructions: None,
    };
    save_bot(host, &profile)?;
    host.inner.bots.lock().expect("bots").push(profile.clone());
    let _ = host
        .inner
        .cards_tx
        .send(CardUpdate::BotChanged(Arc::new(profile.clone())));
    Ok(profile)
}

/// Replace a bot's profile (v1 ChannelBotProfiles update: fields not given stay). Saved, then
/// broadcast as `bot_changed`. A changed name or purpose rotates the bot's session on its next
/// message (see [super::brief]).
pub(crate) fn update_bot(
    host: &Host,
    bot_id: &BotId,
    change: impl FnOnce(&mut BotProfile),
) -> Result<Option<BotProfile>, StoreError> {
    let Some(mut profile) = host.bot(bot_id) else {
        return Ok(None);
    };
    change(&mut profile);
    save_bot(host, &profile)?;
    {
        let mut bots = host.inner.bots.lock().expect("bots");
        if let Some(slot) = bots.iter_mut().find(|b| &b.bot_id == bot_id) {
            *slot = profile.clone();
        }
    }
    let _ = host
        .inner
        .cards_tx
        .send(CardUpdate::BotChanged(Arc::new(profile.clone())));
    Ok(Some(profile))
}

/// The bot whose session thread this is.
pub(crate) fn bot_of_thread(host: &Host, thread: &goat2_contracts::ThreadId) -> Option<BotProfile> {
    host.inner
        .bots
        .lock()
        .expect("bots")
        .iter()
        .find(|b| &b.session_thread_id == thread)
        .cloned()
}

/// Load `bots/*.json`; create the main bot GOAT on first start.
pub(crate) fn load_bots(host: &Host) -> Result<(), StoreError> {
    let dir = bots_dir(host);
    let mut bots = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "json")
                && let Ok(bytes) = std::fs::read(&path)
                && let Ok(profile) = serde_json::from_slice::<BotProfile>(&bytes)
            {
                bots.push(profile);
            }
        }
    }
    bots.sort_by(|a, b| {
        (a.role != BotRole::Main, &a.name).cmp(&(b.role != BotRole::Main, &b.name))
    });
    let has_main = bots.iter().any(|b| b.role == BotRole::Main);
    *host.inner.bots.lock().expect("bots") = bots;
    if !has_main {
        create_bot(
            host,
            "GOAT".to_owned(),
            "Your main bot".to_owned(),
            BotFace {
                shape: "goat".to_owned(),
                color: "#0169CC".to_owned(),
                goat: true,
            },
            ModelSelection {
                instance_id: ProviderInstanceId::new("codex"),
                model: DEFAULT_CODEX_MODEL.to_owned(),
                options: None,
            },
            BotRole::Main,
        )?;
    }
    Ok(())
}
