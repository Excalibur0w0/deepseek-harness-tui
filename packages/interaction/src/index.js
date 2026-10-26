/**
 * @dsh-tui/interaction — the terminal answerer for tool approvals
 * (`approval/request`) and `ask_user_question` (`user-questions/request`),
 * shown as opencode-style panels in place of the prompt. It is the profile's
 * only terminal answerer and answers for every Agent in the process,
 * including delegated children; once the TUI closes it delegates with
 * `next()`. Each approval outcome is also emitted as `tui/approval`
 * (callId, outcome) so the transcript can mark refused calls.
 */

import { toolView } from '@dsh-tui/render'
import { BoxRenderable, ListView, TextareaRenderable, discard, keyHints, panelFrame, spans, text } from '@dsh-tui/ui'

/** Stable Cordis plugin name. */
export const name = 'tui-interaction'

/** The terminal that shows the panels. */
export const inject = ['tuiConsole']

/** Approval choices, in display order. */
const APPROVAL_OPTIONS = [
  { label: '允许一次', outcome: 'allowed-once' },
  { label: '拒绝', outcome: 'rejected' },
]

/** Question options visible at once. */
const QUESTION_ROWS = 8

/**
 * Answer approval and user-question requests from the terminal.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context carrying the TUI console.
 */
export function apply(ctx) {
  const terminal = ctx.get('tuiConsole')
  /** Tool calls by call id across every Session, so approvals can show what they approve. */
  const calls = new Map()
  const answering = () => terminal.isOpen && ctx.get('tuiChat')?.closing !== true

  ctx.on('session/event', (_session, event) => {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data)
    else if (event.type === 'tool/result') calls.delete(event.data.message.toolCallId)
  })

  ctx.on('approval/request', (request, next) => {
    if (!answering()) return next()
    const call = request.callId === undefined ? undefined : calls.get(request.callId)
    const view = toolView(call?.name ?? request.toolName, call?.arguments, ctx.get('tuiChat')?.cwd)
    const child = request.agent !== ctx.get('tuiChat')?.agent
    return terminal.exclusive(async () => {
      const outcome = await askApproval(terminal, request, view, child)
      if (request.callId !== undefined) ctx.emit('tui/approval', request.callId, outcome)
      return outcome
    })
  })

  ctx.on('user-questions/request', (request, next) => {
    if (!answering()) return next()
    return terminal.exclusive(async () => (await askQuestions(terminal, request)) ?? next())
  })
}

/**
 * Ask whether to allow one tool call, like opencode's permission prompt.
 * @param {object} terminal - the TUI console.
 * @param {object} request - the approval request.
 * @param {{ icon: string, title: string }} view - how the call is titled.
 * @param {boolean} child - whether a delegated child Agent is asking.
 * @returns {Promise<'allowed-once' | 'rejected' | 'cancelled'>} the approval outcome.
 */
async function askApproval(terminal, request, view, child) {
  const { renderer, palette } = terminal
  const reason = request.displayReason?.zh ?? request.displayReason?.en ?? request.reason
  const outcome = await terminal.runPanel(done => {
    const { root, body, footer } = panelFrame(renderer, palette, palette.warning)
    body.add(text(renderer, spans(
      { text: '△ ', fg: palette.warning },
      { text: '需要确认', fg: palette.text },
      child && { text: '  [子 agent]', fg: palette.textMuted },
    )))
    body.add(text(renderer, spans({ text: `${view.icon} `, fg: palette.textMuted }, { text: view.title, fg: palette.text }), { marginLeft: 1 }))
    if (reason !== undefined && reason !== '') body.add(text(renderer, reason, { fg: palette.textMuted, marginLeft: 1 }))
    const chips = new BoxRenderable(renderer, { flexDirection: 'row', gap: 1, flexShrink: 0 })
    footer.add(chips)
    footer.add(text(renderer, spans(...keyHints(palette, [['⇆', '选择'], ['enter', '确认'], ['esc', '拒绝']])), { wrapMode: 'none' }))
    let selected = 0
    const render = () => {
      for (const child of [...chips.getChildren()]) discard(child)
      APPROVAL_OPTIONS.forEach((option, index) => {
        const active = index === selected
        chips.add(text(renderer, spans({
          text: ` ${option.label} `,
          fg: active ? palette.background : palette.textMuted,
          bg: active ? palette.warning : palette.backgroundPanel,
        })))
      })
    }
    render()
    return {
      renderable: root,
      onKey: key => {
        switch (key.name) {
          case 'left':
          case 'right':
          case 'tab':
            selected = (selected + 1) % APPROVAL_OPTIONS.length
            render()
            return
          case 'return':
            done(APPROVAL_OPTIONS[selected].outcome)
            return
          case 'y':
            done('allowed-once')
            return
          case 'n':
          case 'escape':
            done('rejected')
            return
          case 'c':
            if (key.ctrl) done('rejected')
            return
          default:
            return
        }
      },
    }
  }, request.signal)
  return outcome ?? 'cancelled'
}

/**
 * Ask each question of a user-questions request in turn, like opencode's
 * question prompt: a numbered option list plus a free-text answer.
 * @param {object} terminal - the TUI console.
 * @param {object} request - the user-questions request.
 * @returns {Promise<{ answers: Array<{ id: string, selected: string[], custom?: string }> } | undefined>} the answers, or undefined when the user cancels.
 */
async function askQuestions(terminal, request) {
  const answers = []
  for (const [index, item] of request.questions.entries()) {
    const answer = await askQuestion(terminal, request.signal, item, index, request.questions.length)
    if (answer === undefined) return undefined
    answers.push(answer)
  }
  return { answers }
}

/**
 * @returns {Promise<{ id: string, selected: string[], custom?: string } | undefined>} one answer, or undefined when cancelled.
 */
function askQuestion(terminal, signal, item, index, total) {
  const { renderer, palette } = terminal
  const options = item.options ?? []
  const multi = item.multiSelect === true
  return terminal.runPanel(done => {
    const { root, body, footer } = panelFrame(renderer, palette, palette.accent)
    body.add(text(renderer, spans(
      { text: '? ', fg: palette.accent },
      total > 1 && { text: `${index + 1}/${total} `, fg: palette.textMuted },
      item.header && { text: `${item.header}  `, fg: palette.accent, bold: true },
      { text: item.question, fg: palette.text },
      multi && !item.question.includes('多选') && { text: '（可多选）', fg: palette.textMuted },
    )))
    if (item.detail) body.add(text(renderer, item.detail, { fg: palette.textMuted, marginLeft: 2 }))
    const picked = new Set()
    const list = new ListView(renderer, palette, QUESTION_ROWS)
    const renderList = () => list.setItems([
      ...options.map((option, optionIndex) => ({
        parts: [
          multi && { text: picked.has(option.label) ? '[✓] ' : '[ ] ', fg: picked.has(option.label) ? palette.success : palette.textMuted },
          { text: `${optionIndex + 1}. ${option.label}`, fg: palette.text },
        ],
        description: option.description,
      })),
      { parts: [{ text: '输入自己的答案…', fg: palette.textMuted }] },
    ])
    renderList()
    body.add(list.renderable)

    const input = new TextareaRenderable(renderer, {
      width: '100%',
      minHeight: 1,
      maxHeight: 4,
      backgroundColor: palette.backgroundElement,
      focusedBackgroundColor: palette.backgroundElement,
      textColor: palette.text,
      focusedTextColor: palette.text,
      placeholder: '输入回答，enter 提交',
      placeholderColor: palette.textMuted,
      visible: false,
      keyBindings: [{ name: 'return', action: 'submit' }, { name: 'return', shift: true, action: 'newline' }],
      onSubmit: () => {
        const custom = input.plainText.trim()
        if (custom === '') return
        done({ id: item.id, selected: [...picked], custom })
      },
    })
    body.add(input)
    const hints = text(renderer, '', { wrapMode: 'none' })
    footer.add(hints)
    let typing = false
    const listHints = [['↑↓', '选择'], ...multi ? [['space', '勾选']] : [], ['enter', '确认'], ['esc', '取消']]
    const setTyping = value => {
      typing = value
      input.visible = value
      list.renderable.visible = !value
      if (value) input.focus()
      else input.blur()
      hints.content = spans(...keyHints(palette, value ? [['enter', '提交'], ['esc', '返回选项']] : listHints))
    }
    setTyping(options.length === 0)

    const choose = optionIndex => {
      if (optionIndex >= options.length) {
        setTyping(true)
        return
      }
      const label = options[optionIndex].label
      if (!multi) {
        done({ id: item.id, selected: [label] })
        return
      }
      done({ id: item.id, selected: picked.size > 0 ? [...picked] : [label] })
    }

    return {
      renderable: root,
      onKey: key => {
        if (typing) {
          if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            if (options.length === 0) done(undefined)
            else setTyping(false)
            return true
          }
          return false
        }
        switch (key.name) {
          case 'up':
          case 'down':
            list.move(key.name === 'up' ? -1 : 1)
            return true
          case 'space':
            if (multi && list.active < options.length) {
              const label = options[list.active].label
              if (picked.has(label)) picked.delete(label)
              else picked.add(label)
              renderList()
            }
            return true
          case 'return':
            choose(list.active)
            return true
          case 'escape':
            done(undefined)
            return true
          default:
            if (key.ctrl && key.name === 'c') {
              done(undefined)
              return true
            }
            if (/^[1-9]$/.test(key.name) && Number(key.name) <= options.length) {
              list.active = Number(key.name) - 1
              list.render()
              if (!multi) choose(list.active)
            }
            return true
        }
      },
    }
  }, signal)
}
