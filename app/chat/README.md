# Chat

The open chat's messages in the nsh desktop app.

`ChatMessageList` shows a `ChatTranscriptState` as `ChatTranscriptStore`
(`app/state`) holds it. It reads nothing itself and keeps no copy of the
conversation:

```tsx
<ChatMessageList
	transcript={() => chat.state()}
	messages={() => chat.messages()}
	onRetry={() => chat.refresh()}
	onVisibleRangeChange={(start, end) => chat.loadRange(start, end)}
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

## Rows are kept by place

`messages` must hold every message of the chat in order, so that index i is
always message i: the store's `messages()`, which joins the placeholders of
the messages not loaded with the loaded ones. The list keeps a row by its
index, not by its message's id, because the reducer names every reply anew
each time the chat is read again. Kept by place, a row stays measured and
where it is across such a read; fed only the loaded messages, every index
would shift when the loaded window moves.

## Loading what shows

A message the store has not read yet is a `historyPlaceholder`: its row
(`ChatHistoryPlaceholder`) is a quiet box at the height the message's
length estimates, shared with the WebUI's placeholder
(`src/lib/chat/history-placeholder-height.ts`), so the rows around it
hold about their final places. The list reports the first and last places
on screen as `onVisibleRangeChange`; the shell gives it the store's
`loadRange`, which reads the pages holding them, and the loaded messages
take their rows' places.

## Following and reading

At its end the list follows a reply as it grows, and when the turn settles.
Scrolled up by more than a few points it leaves the rows in view where they
are, whatever is added below, and shows a button that returns to the latest
message. Both come from the native list (`maintainVisibleContentPosition`);
the button appears by the rule the WebUI uses
(`src/lib/chat/chat-scroll-to-latest.ts`).

## Where a chat was read to

`ChatMessageList` keeps the place each chat (`sessionKey`) was read to: the
row the viewport starts on and how far past it, which the list's
`measureScrollPosition` reports as it scrolls (`onScrollPositionChange`).
Opened again, the list gets that place back as `restorePosition`: it starts
on the row (`initialScrollIndex`) and the first viewable report settles the
offset (`scrollToIndex`), so a reopened chat shows exactly where it was left.
A chat never opened starts on the last message (`initialScrollAtEnd`).

## The outline rail

`ConversationOutlineRail` draws the chat's rounds — one per user message,
built with the WebUI's `buildConversationOutline` — as ticks on the list's
left edge. A press or Enter jumps to that round's message with
`scrollToIndex`; a message still not loaded is a placeholder row at its
index, so the jump lands on it and the visible-range report asks the store
for its page. The active tick follows the scroll: it is the last round that
starts on or before the first visible row (`getOutlineIndexForVisibleRange`),
the last one while the list sits at its end.

## Where later pieces plug in

- `onVisibleRangeChange` tells the store the places on screen, so it
  reads the pages holding them.
- `userBody` and `assistantBody` draw a message's content inside its row.
  Without them the row shows the message's plain text; the Markdown renderer
  and tool activity replace it here and leave the list alone.
- `footer` sits under the last message and scrolls with the messages.
- `empty` is what a chat without messages shows.

The composer, the model controls and the session header are siblings of the
list, not parts of it.
