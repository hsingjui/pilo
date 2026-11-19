# Chat

The open chat's messages in the nsh desktop app.

`ChatMessageList` shows a `ChatTranscriptState` as `ChatTranscriptStore`
(`desktop/state`) holds it. It reads nothing itself and keeps no copy of the
conversation:

```tsx
<ChatMessageList
	transcript={() => chat.state()}
	onRetry={() => chat.refresh()}
	empty={() => <NewChatHero />}
/>
```

| Transcript                                 | Shown                                           |
| ------------------------------------------ | ----------------------------------------------- |
| `closed`                                   | nothing                                         |
| `loading`, no conversation yet             | the history skeleton                            |
| `loading`, a conversation kept from before | that conversation: a refresh never blanks       |
| `failed`                                   | the failure, with Retry when `onRetry` is given |
| `not_loaded`                               | waiting for the running turn to settle          |
| `ready`, no message                        | `empty`                                         |
| `ready`                                    | the messages, opened on the last one            |

The messages are rows of a native `List`: only the rows near the viewport
exist, whatever the chat's length. Each chat (`sessionKey`) gets a list of
its own, so one chat's rows and scroll position never show under another.

## Where later pieces plug in

- `userBody` and `assistantBody` draw a message's content inside its row.
  Without them the row shows the message's plain text; the Markdown renderer
  and tool activity replace it here and leave the list alone.
- `footer` sits under the last message and scrolls with the messages.
- `empty` is what a chat without messages shows.

The composer, the model controls and the session header are siblings of the
list, not parts of it.
