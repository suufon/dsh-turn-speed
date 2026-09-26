/**
 * dsh-turn-speed, browser half.
 *
 * Puts 本轮速度 INTO the shipped 会话统计 dialog: it appends `dt`/`dd` rows to
 * the dialog's `<dl data-session-stats-details>` so the per-turn figures sit
 * directly under the shipped 模型用时 / 工具调用用时 / 首 token 平均 /
 * 输出速度（TPS） rows, in the dialog's own grid and type styles.
 *
 * Why DOM injection rather than a slot: ui-chat hard-codes that `<dl>` and
 * declares no slot inside the dialog, so there is no extension point to
 * register into. Appending trailing nodes to the `dl` is safe against React's
 * reconciliation (React only ever removes children it created, and its rows
 * are a contiguous prefix of the `dl`), and a MutationObserver re-asserts the
 * rows whenever React rewrites the panel — self-healing, no fighting.
 *
 * Where the numbers come from: the Session Controller's own event window
 * (`ctx.sessions`), not React and not a slot. This half therefore has NO
 * dependency on `conversation.composer.dock` or any standard-kit hook, which
 * is the dependency that left v0.1.0's pill invisible.
 *
 *   - 本轮输出速度（TPS）: decode-only, Σ output tokens ÷ Σ(firstToken →
 *     assistant/message) over the turn's steps — the same reading the shipped
 *     dialog's 输出速度（TPS） row takes over the whole session, so 本轮 and
 *     会话 are directly comparable.
 *   - 本轮端到端速度: Σ output tokens ÷ the turn's own wall time
 *     (`turn/start` → `turn/end`), so TTFT and tool waits are included. While
 *     the turn runs, the clock ticks locally once a second.
 *
 * The first-token scan reproduces @deepseek-ai/dsh-llm's
 * `assistantStreamFirstTokenTime` exactly (packed runs reconstruct each
 * delta's time from `time0` + cumulative `dt`), so our numbers agree with the
 * host projection to the millisecond.
 *
 * Self-diagnosis: this half reports its own state to the host half's
 * `/turn-speed-api` route (loopback, no browser cookie needed), so the plugin
 * can be verified from a terminal without a browser console.
 *
 * Hand-written ModuleLoader bundle (no build step). It requires nothing but
 * the platform seeds, so it adds no graph row.
 */

window.__ModuleLoader__.load({
  id: 'dsh-turn-speed',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** Reported to the host so a version mismatch is visible from a terminal. */
    var VERSION = '0.2.0';
    /** Host half's loopback diagnostics route. */
    var API_BASE = '/turn-speed-api';
    /** The shipped 会话统计 dialog's details list, in ui-chat's DOM. */
    var DL_SELECTOR = 'dl[data-session-stats-details]';
    /** Live re-render cadence for a still-running turn's wall clock. */
    var TICK_MS = 1000;
    /** Retry cadence while a session's binding is not ready yet. */
    var BIND_RETRY_MS = 250;
    /** Candidate turns scanned back from the tail (newest first). */
    var MAX_TURNS_BACK = 3;
    /** Report coalescing floor, so a streaming turn cannot flood the route. */
    var REPORT_MIN_MS = 400;

    //#region copy
    /**
     * Self-contained dictionary. The dialog needs row labels the chat locale
     * namespace does not carry, and a missing key would render as a raw key.
     * @deepseek-ai/dsh-client-locale points `<html lang>` at the active locale,
     * so that is the switch.
     */
    var STRINGS = {
      zh: {
        turn: '本轮',
        previous: '上一轮',
        turnNo: '轮次',
        turnNoValue: function (turn) { return '第 ' + turn + ' 轮'; },
        decode: '输出速度（TPS）',
        endToEnd: '端到端速度',
        ttft: '首 token（TTFT）',
        runTime: '用时',
        outputTokens: '输出 tokens',
        steps: '步数',
        second: '秒',
        minute: '分'
      },
      en: {
        turn: 'This turn',
        previous: 'Last turn',
        turnNo: 'Turn',
        turnNoValue: function (turn) { return 'Turn ' + turn; },
        decode: 'output speed (TPS)',
        endToEnd: 'end-to-end speed',
        ttft: 'TTFT',
        runTime: 'run time',
        outputTokens: 'output tokens',
        steps: 'steps',
        second: 's',
        minute: 'm'
      }
    };

    /**
     * Active dictionary.
     * @returns the zh copy when the document locale starts with 'zh', else en.
     */
    function dict() {
      var tag = '';
      try {
        tag = String(document.documentElement.lang || (typeof navigator !== 'undefined' ? navigator.language : '') || '');
      } catch (error) {
        tag = '';
      }
      return tag.toLowerCase().indexOf('zh') === 0 ? STRINGS.zh : STRINGS.en;
    }

    /**
     * Row label for one per-turn figure, scoped by which turn is on display.
     * @param t - active dictionary.
     * @param current - whether the displayed turn is the newest one.
     * @param label - the bare figure label.
     * @returns the scoped label.
     */
    function scoped(t, current, label) {
      return (current ? t.turn : t.previous) + label;
    }
    //#endregion

    //#region stream readings
    /**
     * Whether one stream chunk carries the model's first output token.
     * Mirrors @deepseek-ai/dsh-llm's `isTokenDelta`.
     * @param chunk - any stream chunk.
     * @returns true for a non-empty text, reasoning, or Tool-call fragment.
     */
    function isTokenDelta(chunk) {
      if (chunk === null || typeof chunk !== 'object') return false;
      switch (chunk.type) {
        case 'text-delta':
        case 'reasoning-delta':
          return chunk.text !== '';
        case 'tool-call-delta':
          return chunk.argumentsDelta !== '' || chunk.name !== undefined;
        default:
          return false;
      }
    }

    /**
     * Time of the first member of one packed delta run that is non-empty, each
     * member's time reconstructed as `time0` + cumulative `dt`.
     * @param run - one packed run record.
     * @param predicate - fragment acceptance test.
     * @returns the reconstructed time, or undefined.
     */
    function firstRunMemberTime(run, predicate) {
      var fragments = run.type === 'tool-call-chunks' ? run.args : run.texts;
      if (!Array.isArray(fragments)) return undefined;
      var time = run.time0;
      for (var index = 0; index < fragments.length; index += 1) {
        if (index > 0) time += run.dt[index - 1];
        if (predicate(fragments[index])) return time;
      }
      return undefined;
    }

    /**
     * Time of the first token contributed by one packed run.
     * Mirrors @deepseek-ai/dsh-llm's `runFirstTokenTime`.
     * @param run - one packed run record.
     * @returns the time, or undefined.
     */
    function runFirstTokenTime(run) {
      if (run.type === 'tool-call-chunks' && run.name !== undefined) return run.time0;
      return firstRunMemberTime(run, function (fragment) { return fragment !== ''; });
    }

    /**
     * Time of the model's first output token inside one compact stream.
     * Mirrors @deepseek-ai/dsh-llm's `assistantStreamFirstTokenTime`.
     * @param stream - compact stream records from one settlement.
     * @returns the time, or undefined when the stream carries no token.
     */
    function streamFirstTokenTime(stream) {
      if (!Array.isArray(stream)) return undefined;
      for (var index = 0; index < stream.length; index += 1) {
        var record = stream[index];
        if (record === null || typeof record !== 'object') continue;
        var time = record.type === 'chunk'
          ? (isTokenDelta(record.chunk) ? record.time : undefined)
          : runFirstTokenTime(record);
        if (time !== undefined) return time;
      }
      return undefined;
    }

    /**
     * Provider-reported output tokens, guarded the way the host projection
     * guards node usage.
     * @param usage - an assistant/message event's optional usage record.
     * @returns the count, or null when unreported or invalid.
     */
    function usageOutputTokens(usage) {
      if (usage === null || typeof usage !== 'object') return null;
      var value = usage.outputTokens;
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    }

    /**
     * The durable event of one window entry, or the transient event itself.
     * @param entry - one `{ type, event }` window entry.
     * @returns the event, or null.
     */
    function entryEvent(entry) {
      if (entry === null || typeof entry !== 'object') return null;
      var event = entry.event === undefined ? entry : entry.event;
      if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return null;
      return event;
    }
    //#endregion

    //#region folding
    /** One turn's in-progress fold. */
    function newBucket(turn) {
      return {
        turn: turn,
        steps: 0,
        decodeMs: 0,
        outputTokens: 0,
        /** Sum and count of per-step TTFT, so the turn reports the same
         * AVERAGE the shipped 首 token 平均（TTFT） row reports. */
        ttftMs: 0,
        ttftSteps: 0,
        sampled: false,
        startTime: null,
        endTime: null,
        /** The step currently open, or null. Exactly one at a time, matching
         * the host unit's own `openStep`, so a step that settles more than once
         * cannot double-count. */
        open: null
      };
    }

    /**
     * Absorb one turn-scoped event into its fold.
     *
     * This is a faithful port of @deepseek-ai/dsh-session-stats' `apply`, so a
     * per-turn figure is the same reading the shipped session-wide rows take —
     * including the parts that are easy to get subtly wrong: only ONE open step
     * exists at a time, and its first-token time is taken from the first source
     * that supplies one (`assistant/attempt`, a live chunk, or the settlement's
     * own stream, in that order of arrival).
     *
     * @param bucket - the turn's fold.
     * @param event - a durable or transient event.
     */
    function absorb(bucket, event) {
      var data = event.data;
      if (data === null || typeof data !== 'object') return;
      var step = typeof data.step === 'number' ? data.step : null;
      switch (event.type) {
        case 'step/start':
          if (step === null) return;
          bucket.open = { step: step, startTime: event.time, firstTokenTime: null };
          return;
        case 'step/end':
          bucket.steps += 1;
          return;
        case 'assistant/attempt': {
          if (bucket.open === null || bucket.open.step !== step) return;
          if (bucket.open.firstTokenTime !== null) return;
          var attempted = streamFirstTokenTime(data.stream);
          if (attempted === undefined) return;
          bucket.open.firstTokenTime = attempted;
          return;
        }
        case 'assistant/live-chunk': {
          if (bucket.open === null || bucket.open.step !== step) return;
          if (bucket.open.firstTokenTime !== null) return;
          if (!isTokenDelta(data.chunk)) return;
          bucket.open.firstTokenTime = event.time;
          return;
        }
        case 'assistant/message': {
          if (bucket.open === null || bucket.open.step !== step) return;
          var open = bucket.open;
          var firstToken = open.firstTokenTime;
          if (firstToken === null) {
            var settled = streamFirstTokenTime(data.stream);
            if (settled !== undefined) firstToken = settled;
          }
          bucket.open = null;
          if (firstToken === null) return;
          bucket.ttftMs += Math.max(0, firstToken - open.startTime);
          bucket.ttftSteps += 1;
          var tokens = usageOutputTokens(data.usage);
          if (tokens === null) return;
          bucket.decodeMs += Math.max(0, event.time - firstToken);
          bucket.outputTokens += tokens;
          bucket.sampled = true;
          return;
        }
        default:
          return;
      }
    }

    /**
     * The turn an event belongs to.
     * @param event - a durable or transient event.
     * @returns the turn number, or null.
     */
    function eventTurn(event) {
      var data = event.data;
      if (data === null || typeof data !== 'object') return null;
      var turn = data.turn;
      return typeof turn === 'number' && Number.isFinite(turn) ? turn : null;
    }

    /**
     * Collect the newest turns' folds.
     *
     * Two passes, and the order matters: a turn's `assistant/message`
     * settlement FOLLOWS the `assistant/attempt` and live-chunk events that
     * carry its first-token time, so the fold has to run forwards or the
     * settlement arrives before the reading it needs and no turn is ever
     * sampled. The first pass walks backwards only to find where the newest
     * `limit` turns begin, which bounds the forward fold to the tail of the log
     * instead of the whole window — for a long session, the difference between
     * a few dozen and a hundred thousand entries per render.
     *
     * @param entries - the session's event window.
     * @param limit - how many turns back to collect at most.
     * @returns the turns, newest first.
     */
    function collectTurns(entries, limit) {
      var buckets = [];
      if (!Array.isArray(entries) || entries.length === 0) return buckets;

      // Pass 1 (backwards): the newest `limit` turn numbers, and the offset of
      // the oldest one's own `turn/start`.
      var wanted = [];
      var startIndex = 0;
      for (var index = entries.length - 1; index >= 0; index -= 1) {
        var event = entryEvent(entries[index]);
        if (event === null) continue;
        var turn = eventTurn(event);
        if (turn === null) continue;
        if (wanted.length === 0 || turn < wanted[wanted.length - 1]) {
          if (wanted.length >= limit) break;
          wanted.push(turn);
        }
        if (event.type === 'turn/start' && turn === wanted[wanted.length - 1]) startIndex = index;
      }
      if (wanted.length === 0) return buckets;

      // Pass 2 (forwards): fold the wanted turns only.
      var byTurn = new Map();
      for (var at = startIndex; at < entries.length; at += 1) {
        var current = entryEvent(entries[at]);
        if (current === null) continue;
        var key = eventTurn(current);
        if (key === null || wanted.indexOf(key) < 0) continue;
        var bucket = byTurn.get(key);
        if (bucket === undefined) {
          bucket = newBucket(key);
          byTurn.set(key, bucket);
        }
        if (current.type === 'turn/start') {
          bucket.startTime = current.time;
          continue;
        }
        if (current.type === 'turn/end') {
          bucket.endTime = current.time;
          continue;
        }
        absorb(bucket, current);
      }

      for (var position = 0; position < wanted.length; position += 1) {
        var found = byTurn.get(wanted[position]);
        if (found !== undefined) buckets.push(found);
      }
      return buckets;
    }

    /**
     * The turn's average TTFT, over the steps that produced one.
     *
     * Deliberately the same statistic as the shipped
     * 首 token 平均（TTFT） row (sum ÷ step count), not the fastest step:
     * this row sits directly under it, so a different definition would read as
     * a contradiction rather than a per-turn view.
     *
     * @param bucket - the turn's fold.
     * @returns average TTFT in milliseconds, or null when no step produced one.
     */
    function turnTtftMs(bucket) {
      if (bucket.ttftSteps === 0) return null;
      return bucket.ttftMs / bucket.ttftSteps;
    }

    /**
     * Display model for the newest turn that carries a sampled reading.
     * @param buckets - collected turns, newest first.
     * @param now - reference instant for a still-running turn's clock.
     * @returns the model, or null when no turn is sampled.
     */
    function buildModel(buckets, now) {
      if (!Array.isArray(buckets) || buckets.length === 0) return null;
      var target = null;
      for (var index = 0; index < buckets.length; index += 1) {
        // A sampled turn needs settleable decode time; a turn whose only
        // settlement carried no usage is skipped rather than shown as 0 tok/s.
        if (buckets[index].sampled && buckets[index].decodeMs > 0 && buckets[index].outputTokens > 0) {
          target = buckets[index];
          break;
        }
      }
      if (target === null) return null;
      var decodeTps = target.outputTokens / (target.decodeMs / 1000);
      if (!Number.isFinite(decodeTps)) return null;
      var running = target.startTime !== null && target.endTime === null;
      var runMs = target.startTime === null ? null : Math.max(0, (running ? now : target.endTime) - target.startTime);
      var endToEndTps = runMs !== null && runMs > 0 ? target.outputTokens / (runMs / 1000) : null;
      return {
        turn: target.turn,
        isCurrent: target.turn === buckets[0].turn,
        running: running,
        decodeTps: decodeTps,
        endToEndTps: endToEndTps,
        ttftMs: turnTtftMs(target),
        runMs: runMs,
        outputTokens: target.outputTokens,
        steps: target.steps
      };
    }
    //#endregion

    //#region formatting
    /**
     * Decode-throughput figure: whole tokens from ten up, one decimal below
     * (identical to the shipped strip's own rounding).
     * @param tps - tokens per second.
     * @returns display number without unit.
     */
    function formatTps(tps) {
      var clamped = Math.max(0, tps);
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
    }

    /**
     * Latency figure: one decimal under ten seconds, whole seconds from there.
     * @param ms - latency in milliseconds.
     * @returns display number without unit.
     */
    function formatLatency(ms) {
      var seconds = Math.max(0, ms) / 1000;
      return seconds < 10 ? String(Math.round(seconds * 10) / 10) : String(Math.round(seconds));
    }

    /**
     * Compact duration: `45.2秒` under a minute, `2分42秒` from there on.
     * @param ms - duration in milliseconds.
     * @param t - active dictionary.
     * @returns display string.
     */
    function formatDuration(ms, t) {
      var seconds = Math.max(0, ms) / 1000;
      if (seconds < 60) return (Math.round(seconds * 10) / 10) + t.second;
      var whole = Math.round(seconds);
      return Math.floor(whole / 60) + t.minute + (whole % 60) + t.second;
    }

    /**
     * Exact token count with thousands separators.
     * @param value - token count.
     * @returns grouped digits.
     */
    function groupDigits(value) {
      var digits = String(Math.max(0, Math.round(value)));
      var groups = [];
      for (var end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
      return groups.join(',');
    }

    /**
     * `42.1 tok/s`, the unit the shipped dialog uses.
     * @param tps - tokens per second.
     * @returns display string.
     */
    function tokensPerSecondText(tps) {
      return formatTps(tps) + ' tok/s';
    }
    //#endregion

    //#region rows
    /**
     * The rows this plugin contributes, in display order. A null value omits
     * the row entirely rather than rendering a placeholder.
     * @param model - the display model.
     * @param t - active dictionary.
     * @returns label/value pairs, keyed by a stable row id.
     */
    function rowSpecs(model, t) {
      var current = model.isCurrent;
      return [
        { key: 'decode', label: scoped(t, current, t.decode), value: tokensPerSecondText(model.decodeTps) },
        { key: 'end-to-end', label: scoped(t, current, t.endToEnd), value: model.endToEndTps === null ? null : tokensPerSecondText(model.endToEndTps) },
        { key: 'ttft', label: scoped(t, current, t.ttft), value: model.ttftMs === null ? null : formatLatency(model.ttftMs) + t.second },
        { key: 'run', label: scoped(t, current, t.runTime), value: model.runMs === null ? null : formatDuration(model.runMs, t) + (model.running ? ' …' : '') },
        { key: 'tokens', label: scoped(t, current, t.outputTokens), value: groupDigits(model.outputTokens) + ' tok' },
        { key: 'steps', label: scoped(t, current, t.steps), value: String(model.steps) },
        { key: 'turn', label: t.turnNo, value: t.turnNoValue(model.turn) }
      ];
    }

    /** Marks every node this plugin owns, so cleanup never touches React's rows. */
    var ROW_ATTR = 'data-turn-speed-row';
    /** Reserved ROW_ATTR value for the divider drawn between the two sections. */
    var SEPARATOR_KEY = '__separator';
    /** Marks the stylesheet this plugin injects. */
    var STYLE_ATTR = 'data-turn-speed-style';
    /** Marks the details list itself while this plugin's rows describe a turn. */
    var TURN_ATTR = 'data-turn-speed';
    /** Marks the details list with the row set currently appended. */
    var KEYS_ATTR = 'data-turn-speed-keys';

    /**
     * Stylesheet for the divider.
     *
     * The dialog already draws its own title rule as `.5px solid
     * var(--dsw-alias-border-l2)`, so the divider reuses exactly that, and the
     * line reads as part of the dialog rather than as an add-on.
     *
     * Two details make it work in the dialog's layout: the `<dl>` is a
     * two-column grid (`grid-template-columns: minmax(76px,auto) minmax(0,1fr)`),
     * so `grid-column: 1 / -1` is what lets a single zero-height element cross
     * BOTH columns instead of stopping at the 16px column gap; and the selector
     * is attribute-qualified rather than class-qualified, so it outranks the
     * dialog's own `.bRhRbq_details dt` rule without depending on that hash
     * class, which changes between builds.
     */
    var SEPARATOR_CSS = DL_SELECTOR + ' > dt[' + ROW_ATTR + '="' + SEPARATOR_KEY + '"]{'
      + 'grid-column:1/-1;height:0;padding:0;'
      + 'border-top:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));'
      + 'margin:5px 0 1px}';

    /**
     * Whether one node is this plugin's own contribution.
     * @param node - any node.
     * @returns true when the node carries this plugin's row or style marker.
     */
    function isOwnNode(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return false;
      return node.getAttribute(ROW_ATTR) !== null || node.getAttribute(STYLE_ATTR) !== null;
    }

    /**
     * Add this plugin's stylesheet once.
     *
     * Injected into the head, which the controller's MutationObserver does not
     * watch (it observes the body), so the stylesheet itself can never look like
     * a panel change and trigger a render.
     *
     * @param doc - the document to style.
     */
    function injectStyles(doc) {
      try {
        if (typeof doc.createElement !== 'function') return;
        var head = doc.head !== undefined && doc.head !== null ? doc.head : doc.documentElement;
        if (head === undefined || head === null || typeof head.appendChild !== 'function') return;
        if (typeof head.querySelector === 'function' && head.querySelector('style[' + STYLE_ATTR + ']') !== null) return;
        var style = doc.createElement('style');
        style.setAttribute(STYLE_ATTR, 'true');
        style.textContent = SEPARATOR_CSS;
        head.appendChild(style);
      } catch (error) {
        /* the divider is cosmetic: never let styling break the plugin */
      }
    }

    /**
     * Whether a MutationObserver batch consists ONLY of this plugin's own writes.
     *
     * This is what keeps a render from being its own trigger. A `patching`
     * boolean cannot do the job: MutationObserver callbacks are delivered
     * asynchronously, after the write that queued them has already returned and
     * any such flag has been cleared. Inspecting the records is the only
     * reliable test.
     *
     * @param records - the observer's mutation records.
     * @returns true when no record concerns a node or attribute React owns.
     */
    function isOwnMutation(records) {
      if (!Array.isArray(records) || records.length === 0) return false;
      for (var index = 0; index < records.length; index += 1) {
        var record = records[index];
        if (record === null || typeof record !== 'object') return false;
        // A write inside one of our own rows (its text, its marker attribute).
        if (isOwnNode(record.target)) continue;
        // An attribute change on the list itself, but only ours.
        if (record.type === 'attributes') {
          if (String(record.attributeName || '').indexOf(TURN_ATTR) !== 0) return false;
          continue;
        }
        var touched = [];
        var added = record.addedNodes;
        var removed = record.removedNodes;
        if (added !== null && added !== undefined) for (var at = 0; at < added.length; at += 1) touched.push(added[at]);
        if (removed !== null && removed !== undefined) for (var from = 0; from < removed.length; from += 1) touched.push(removed[from]);
        if (touched.length === 0) return false;
        for (var node = 0; node < touched.length; node += 1) if (!isOwnNode(touched[node])) return false;
      }
      return true;
    }

    /**
     * Remove every row this plugin contributed.
     * @param doc - the document to clean.
     */
    function removeRows(doc) {
      var existing = doc.querySelectorAll('[' + ROW_ATTR + ']');
      for (var index = 0; index < existing.length; index += 1) {
        var node = existing[index];
        if (node.parentNode !== null && node.parentNode !== undefined) node.parentNode.removeChild(node);
      }
    }

    /**
     * Append one label/value pair to the dialog's details list.
     * @param doc - the document to build in.
     * @param dl - the dialog's `<dl>`.
     * @param spec - the row spec.
     */
    function appendRow(doc, dl, spec) {
      var dt = doc.createElement('dt');
      dt.setAttribute(ROW_ATTR, spec.key);
      dt.textContent = spec.label;
      var dd = doc.createElement('dd');
      dd.setAttribute(ROW_ATTR, spec.key);
      dd.textContent = spec.value;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }

    /**
     * Whether the details list already ends with exactly React's committed rows
     * followed by this plugin's own block: the divider, then our rows.
     *
     * Verified structurally rather than by the key attribute alone, because
     * React mounts a newly-appearing stat row with `appendChild`, which would
     * land AFTER our block and split it. Counting children is not enough — the
     * block has to occupy the tail, in order, with the divider still first.
     *
     * @param dl - the dialog's `<dl>`.
     * @param specs - the rows this plugin contributes, in order.
     * @returns true when the trailing children are exactly our block.
     */
    function hasCorrectBlock(dl, specs) {
      var children = dl.children;
      // The divider's sole `dt` plus two nodes per row.
      var needed = 1 + specs.length * 2;
      if (children === undefined || children === null || children.length < needed) return false;
      var start = children.length - needed;
      var divider = children[start];
      if (divider.tagName !== 'DT' || divider.getAttribute(ROW_ATTR) !== SEPARATOR_KEY) return false;
      for (var index = 0; index < specs.length; index += 1) {
        var dt = children[start + 1 + index * 2];
        var dd = children[start + 2 + index * 2];
        if (dt.tagName !== 'DT' || dd.tagName !== 'DD') return false;
        if (dt.getAttribute(ROW_ATTR) !== specs[index].key) return false;
        if (dd.getAttribute(ROW_ATTR) !== specs[index].key) return false;
      }
      return true;
    }

    /**
     * Keep the dialog's details list in sync with the model.
     *
     * React owns the `dl`'s committed rows and ours are a trailing block behind
     * a divider, so the work here is to rebuild that block whenever the visible
     * row set or its position changed, and to update text otherwise. React never
     * removes a node it did not create, which is what makes the block safe; and
     * because a rebuilt block satisfies the same check, this converges instead
     * of fighting the tree on every mutation.
     *
     * Putting a divider between them is why the two sections can read as
     * separate at all: without it the dialog presents one undifferentiated list
     * in which a session-wide figure and a per-turn figure look interchangeable.
     *
     * @param model - the display model, or null to contribute nothing.
     * @param doc - the document to patch.
     * @returns the number of rows contributed.
     */
    function syncDialog(model, doc) {
      var target = doc === undefined ? document : doc;
      var dl = target.querySelector(DL_SELECTOR);
      if (dl === null) return 0;
      if (model === null) {
        removeRows(target);
        dl.removeAttribute(TURN_ATTR);
        dl.removeAttribute(KEYS_ATTR);
        return 0;
      }
      injectStyles(target);
      var specs = rowSpecs(model, dict()).filter(function (spec) { return spec.value !== null && spec.value !== undefined; });
      var keys = specs.map(function (spec) { return spec.key; }).join(',');
      if (dl.getAttribute(KEYS_ATTR) !== keys || !hasCorrectBlock(dl, specs)) {
        removeRows(target);
        // The divider, opening the second section.
        var separator = target.createElement('dt');
        separator.setAttribute(ROW_ATTR, SEPARATOR_KEY);
        separator.setAttribute('aria-hidden', 'true');
        dl.appendChild(separator);
        for (var index = 0; index < specs.length; index += 1) appendRow(target, dl, specs[index]);
        dl.setAttribute(KEYS_ATTR, keys);
      } else {
        for (var at = 0; at < specs.length; at += 1) {
          var spec = specs[at];
          var dt = dl.querySelector('dt[' + ROW_ATTR + '="' + spec.key + '"]');
          var dd = dl.querySelector('dd[' + ROW_ATTR + '="' + spec.key + '"]');
          if (dt !== null && dt.textContent !== spec.label) dt.textContent = spec.label;
          if (dd !== null && dd.textContent !== spec.value) dd.textContent = spec.value;
        }
      }
      // Debug handle: the turn these rows describe, written only on change.
      var turnMark = String(model.turn);
      if (dl.getAttribute(TURN_ATTR) !== turnMark) dl.setAttribute(TURN_ATTR, turnMark);
      return specs.length;
    }
    //#endregion

    //#region controller
    /**
     * Build the live controller bound to the client context.
     * @param ctx - client plugin context carrying the `sessions` service.
     * @returns the controller (also exposed for tests).
     */
    function createController(ctx) {
      var state = {
        hasSessions: false,
        current: null,
        hasBinding: false,
        windowEntries: 0,
        model: null,
        dialogSeen: false,
        rows: 0,
        lastError: null,
        lastRenderAt: null,
        renders: 0,
        version: VERSION
      };
      var entries = [];
      var unsubscribes = [];
      var scheduled = false;
      var lastReportAt = 0;
      var disposed = false;
      /** Release for the current event subscription, or null. */
      var releaseEvents = null;
      /** Retry timer for a binding that is not ready yet, or null. */
      var bindTimer = null;
      /** The service handle, so the binding retry can re-resolve. */
      var sessionsRef = null;

      /**
       * One compact snapshot of this half's state for the host's route.
       * @returns the report payload.
       */
      function payload() {
        return {
          version: VERSION,
          href: (function () { try { return String(window.location.href); } catch (error) { return null; } })(),
          hasSessions: state.hasSessions,
          current: state.current,
          hasBinding: state.hasBinding,
          windowEntries: state.windowEntries,
          dialogSeen: state.dialogSeen,
          rows: state.rows,
          renders: state.renders,
          lastRenderAt: state.lastRenderAt,
          lastError: state.lastError,
          model: state.model === null ? null : {
            turn: state.model.turn,
            isCurrent: state.model.isCurrent,
            running: state.model.running,
            decodeTps: state.model.decodeTps,
            endToEndTps: state.model.endToEndTps,
            outputTokens: state.model.outputTokens,
            steps: state.model.steps
          },
          at: Date.now()
        };
      }

      /** Send this half's state to the host half, coalesced. */
      function report() {
        var now = Date.now();
        if (now - lastReportAt < REPORT_MIN_MS) return;
        lastReportAt = now;
        try {
          var body = JSON.stringify(payload());
          var request = window.fetch(API_BASE + '/report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: body,
            keepalive: true
          });
          if (request && typeof request.catch === 'function') request.catch(function () {});
        } catch (error) {
          /* the route is diagnostics only: never let it break the UI */
        }
      }

      /** Fold the current window and push the result into the dialog. */
      function render() {
        if (disposed) return;
        scheduled = false;
        try {
          state.windowEntries = entries.length;
          var buckets = collectTurns(entries, MAX_TURNS_BACK);
          var model = buildModel(buckets, Date.now());
          var doc = typeof document === 'undefined' ? undefined : document;
          state.dialogSeen = doc === undefined ? false : doc.querySelector(DL_SELECTOR) !== null;
          state.rows = state.dialogSeen ? syncDialog(model, doc) : 0;
          state.model = model;
          state.renders += 1;
          state.lastRenderAt = Date.now();
          state.lastError = null;
        } catch (error) {
          state.lastError = String((error && error.message) || error);
        }
        report();
      }

      /** Coalesce any number of triggers into one pending render. */
      function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(render);
        else setTimeout(render, 0);
      }

      /** Point the event subscription at the currently selected session. */
      function retarget(sessions) {
        if (releaseEvents !== null) {
          try {
            releaseEvents();
          } catch (error) {
            /* the previous source may already be gone */
          }
          releaseEvents = null;
        }
        state.hasBinding = false;
        entries = [];
        var id = state.current;
        if (id === null || id === undefined) {
          schedule();
          return;
        }
        var binding = typeof sessions.binding === 'function' ? sessions.binding(id) : undefined;
        if (binding === undefined || binding === null) {
          waitForBinding();
          schedule();
          return;
        }
        var source = binding.eventSource;
        if (source === undefined || source === null || typeof source.getSnapshot !== 'function') {
          waitForBinding();
          schedule();
          return;
        }
        state.hasBinding = true;
        stopWaitingForBinding();
        var read = function () {
          var snapshot = source.getSnapshot();
          entries = snapshot !== null && snapshot !== undefined && Array.isArray(snapshot.entries) ? snapshot.entries : [];
          schedule();
        };
        read();
        if (typeof source.subscribe === 'function') releaseEvents = source.subscribe(read) || null;
      }

      /**
       * Keep retrying the binding.
       *
       * `binding(id)` returns undefined while a session is being opened, and the
       * list's own change notification does not always fire again afterwards —
       * without this the dialog would simply stay empty for that session, which
       * is the silent-stall failure mode this rewrite is meant to remove.
       */
      function waitForBinding() {
        if (bindTimer !== null || disposed) return;
        if (typeof setInterval !== 'function') return;
        bindTimer = setInterval(function () {
          if (disposed) {
            stopWaitingForBinding();
            return;
          }
          if (state.current !== null && state.current !== undefined) retarget(sessionsRef);
          else stopWaitingForBinding();
        }, BIND_RETRY_MS);
      }

      /** Cancel the binding retry, if any. */
      function stopWaitingForBinding() {
        if (bindTimer === null) return;
        clearInterval(bindTimer);
        bindTimer = null;
      }

      /**
       * Wire the controller to the session service.
       * @param sessions - the client's `sessions` service.
       */
      function start(sessions) {
        sessionsRef = sessions;
        state.hasSessions = true;
        var list = sessions.list;
        var onList = function () {
          var snapshot = list.getSnapshot();
          state.current = snapshot !== null && snapshot !== undefined && snapshot.current !== undefined ? snapshot.current : null;
          retarget(sessions);
        };
        if (list !== undefined && list !== null && typeof list.subscribe === 'function') unsubscribes.push(list.subscribe(onList));
        onList();

        if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
          var observer = new MutationObserver(function (records) {
            // Ignore a batch that is entirely this plugin's own writes: our rows
            // ARE DOM mutations, so reacting to them would make render() its own
            // trigger and spin at frame rate forever. Filtering the records is
            // the only reliable test — a "currently patching" flag cannot work,
            // because these callbacks arrive asynchronously, after the write
            // that queued them has already returned.
            if (isOwnMutation(records)) return;
            schedule();
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true });
          unsubscribes.push(function () { observer.disconnect(); });
        }
        if (typeof window !== 'undefined' && typeof window.setInterval === 'function') {
          var timer = window.setInterval(function () {
            // Only a running turn has a moving clock; otherwise stay idle.
            if (state.model !== null && state.model.running) schedule();
          }, TICK_MS);
          unsubscribes.push(function () { window.clearInterval(timer); });
        }
        schedule();
      }

      /**
       * Tear every subscription down.
       */
      function dispose() {
        disposed = true;
        stopWaitingForBinding();
        if (releaseEvents !== null) {
          try {
            releaseEvents();
          } catch (error) {
            /* the source may already be gone */
          }
          releaseEvents = null;
        }
        for (var index = 0; index < unsubscribes.length; index += 1) {
          try {
            unsubscribes[index]();
          } catch (error) {
            /* disposal is best-effort */
          }
        }
        unsubscribes.length = 0;
      }

      return {
        start: start,
        dispose: dispose,
        render: render,
        payload: payload,
        getState: function () { return state; }
      };
    }
    //#endregion

    //#region plugin
    /** The controller of the running plugin, surfaced for the smoke test. */
    var lastController = null;
    /** Anything that stopped activation, surfaced for the smoke test. */
    var lastFailure = null;

    /**
     * Run `onService` as soon as the `sessions` service exists.
     *
     * Deliberately NOT done by declaring `inject: ['sessions']`: a declared
     * inject that never resolves means `apply` never runs, and a plugin that
     * never runs cannot report why — the exact silent no-show this rewrite
     * exists to remove. So activation always proceeds, and the service is
     * waited for here instead.
     *
     * @param resolve - reads the service, returning undefined while absent.
     * @param onService - receives the service once available.
     * @returns the binder, with a `cancel` for disposal.
     */
    function lateBind(resolve, onService) {
      var delivered = false;
      var timer = null;
      var attempts = 0;
      var MAX_ATTEMPTS = 60;

      /** Deliver once, guarding against a throwing resolver. */
      function attempt() {
        if (delivered) return;
        var service = null;
        try {
          service = resolve();
        } catch (error) {
          lastFailure = 'sessions lookup threw: ' + String((error && error.message) || error);
          return;
        }
        if (service === undefined || service === null) return;
        delivered = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        try {
          onService(service);
        } catch (error) {
          lastFailure = 'start failed: ' + String((error && error.message) || error);
        }
      }

      attempt();
      if (!delivered && typeof setInterval === 'function') {
        timer = setInterval(function () {
          attempts += 1;
          if (attempts > MAX_ATTEMPTS) {
            clearInterval(timer);
            timer = null;
            if (lastFailure === null) lastFailure = 'sessions service unavailable after ' + MAX_ATTEMPTS + ' attempts';
            return;
          }
          attempt();
        }, 250);
      }
      return {
        cancel: function () {
          if (timer !== null) {
            clearInterval(timer);
            timer = null;
          }
        }
      };
    }

    /**
     * Browser plugin body: bind to the session service and keep the dialog's
     * per-turn rows current.
     * @param ctx - client root context carrying the `sessions` service.
     */
    function apply(ctx) {
      lastFailure = null;
      var controller = createController(ctx);
      lastController = controller;

      var binder = lateBind(function () { return ctx.get('sessions'); }, function (sessions) {
        controller.start(sessions);
      });

      ctx.effect(function () {
        return function () {
          binder.cancel();
          controller.dispose();
        };
      }, 'turn-speed: dispose controller');

      /** Send one activation report, tolerating a missing or dead route. */
      function reportOutcome() {
        try {
          var outcome = lastFailure === null
            ? { version: VERSION, activated: true, bound: controller.getState().hasBinding, at: Date.now() }
            : { version: VERSION, activated: false, failure: lastFailure, at: Date.now() };
          var request = window.fetch(API_BASE + '/report', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(outcome),
            keepalive: true
          });
          if (request && typeof request.catch === 'function') request.catch(function () {});
        } catch (error) {
          /* the route is diagnostics only: never let it break the UI */
        }
      }

      // Report once now (activation), and once more on the next macrotask so a
      // binder that failed synchronously still reaches the route.
      reportOutcome();
      if (typeof setTimeout === 'function') setTimeout(reportOutcome, 500);
    }

    exports.apply = apply;
    /**
     * Deliberately EMPTY.
     *
     * A declared cordis `inject` that never resolves means the platform never
     * calls `apply`, and a plugin that never runs cannot say why it did not
     * run — the silent no-show that made this plugin's first version invisible
     * with no error anywhere. Nothing here is worth that risk: the `sessions`
     * service is waited for inside `apply` instead (`lateBind`), and a failure
     * to find it is reported to the host route.
     */
    exports.inject = [];
    // Test-only surface: the smoke script exercises the fold, the formatting,
    // the dialog patcher, and the activation path without a browser.
    exports.__internals = {
      VERSION: VERSION,
      API_BASE: API_BASE,
      DL_SELECTOR: DL_SELECTOR,
      ROW_ATTR: ROW_ATTR,
      SEPARATOR_KEY: SEPARATOR_KEY,
      SEPARATOR_CSS: SEPARATOR_CSS,
      STYLE_ATTR: STYLE_ATTR,
      TURN_ATTR: TURN_ATTR,
      KEYS_ATTR: KEYS_ATTR,
      buildModel: buildModel,
      collectTurns: collectTurns,
      createController: createController,
      formatDuration: formatDuration,
      formatLatency: formatLatency,
      formatTps: formatTps,
      groupDigits: groupDigits,
      injectStyles: injectStyles,
      isOwnMutation: isOwnMutation,
      isTokenDelta: isTokenDelta,
      rowSpecs: rowSpecs,
      streamFirstTokenTime: streamFirstTokenTime,
      syncDialog: syncDialog,
      tokensPerSecondText: tokensPerSecondText,
      turnTtftMs: turnTtftMs,
      controller: function () { return lastController; },
      failure: function () { return lastFailure; }
    };
    return module.exports;
  }
});
