import {createMonitor, STALE_MS} from './telemetry.js';

const monitor = createMonitor();
const MB = 1024 * 1024;
const $ = id => document.getElementById(id);
const text = (id, value) => { $(id).textContent = value; };
const number = value => value === null || value === undefined ? '—' : value.toFixed(1);
const clock = at => new Date(at).toLocaleTimeString([], {hour12: false});
let selected = '';
let windowMs = 180000;
let frozen = null;
let inspected = null;
let latestError = '';
let lastSuccess = 0;
let lastEvent = null;
let completedIncident = null;
const rows = new Map();
let loadRun = null;

function uptime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}

function element(tag, className, content) {
    const node = document.createElement(tag);
    node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
}

function svgElement(tag, attributes, content) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    if (content !== undefined) node.textContent = content;
    return node;
}

function choose(host) {
    selected = host;
    frozen = null;
    inspected = null;
    $('pod-select').value = host;
    render();
}

function renderPods(now) {
    const select = $('pod-select');
    if (!selected && monitor.pods.size) selected = monitor.pods.keys().next().value;
    if (monitor.pods.size && select.options[0]?.value === '') select.options[0].remove();
    for (const [host, pod] of monitor.pods) {
        if (!rows.has(host)) {
            const option = document.createElement('option');
            option.value = host;
            option.textContent = host;
            select.append(option);
            const row = element('button', 'pod-card');
            row.type = 'button';
            row.append(element('span', 'pod-host', host), element('span', 'pod-numbers'), element('span', 'pod-state'));
            row.addEventListener('click', () => choose(host));
            $('pod-list').append(row);
            rows.set(host, {row, option});
        }
        const {row} = rows.get(host);
        const age = Math.max(0, Math.floor((now - pod.seenAt) / 1000));
        row.setAttribute('aria-pressed', String(host === selected));
        row.classList.toggle('is-stale', pod.stale);
        row.querySelector('.pod-numbers').textContent = `${number(pod.latest.memory.used / MB)} MiB · ${number(pod.latest.cpu.used === null ? null : pod.latest.cpu.used * 1000)}m CPU`;
        row.querySelector('.pod-state').textContent = `${pod.stale ? 'No recent sample' : pod.latest.oom?.active ? 'OOM allocation active' : 'Responding'} · ${age}s ago · ${pod.latest.version}`;
    }
    for (const [host, {row, option}] of rows) {
        if (!monitor.pods.has(host)) { row.remove(); option.remove(); rows.delete(host); }
    }
    const pending = select.querySelector('[data-pending]');
    if (pending && (monitor.pods.has(pending.value) || pending.value !== selected)) pending.remove();
    if (selected && !monitor.pods.has(selected) && !select.querySelector('[data-pending]')) {
        const option = document.createElement('option');
        option.value = selected;
        option.dataset.pending = 'true';
        option.textContent = `${selected} · waiting for a sample`;
        select.append(option);
    }
    select.value = selected;
    const responding = [...monitor.pods.values()].filter(pod => !pod.stale).length;
    text('pods-summary', `observed pods · ${responding}/${monitor.pods.size} recently seen`);
    if (loadRun) {
        loadRun.peak = Math.max(loadRun.peak, responding);
        text('load-observed', `Observed pods: ${loadRun.baseline} at start → ${responding} now · peak ${loadRun.peak}. HPA state is not queried.`);
    }
}

function drawChart(id, points, metric, end, cursor) {
    const svg = $(id);
    const width = Math.max(svg.clientWidth, 180);
    const height = Math.max(svg.clientHeight, 100);
    const right = width - 12;
    const bottom = height - 28;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const start = end - windowMs;
    const value = sample => metric === 'memory' ? sample.memory.used / MB : sample.cpu.used === null ? null : sample.cpu.used * 1000;
    const limit = points.at(-1)?.sample[metric].limit;
    const capacity = limit ? metric === 'memory' ? limit / MB : limit * 1000 : null;
    const peak = Math.max(0, ...points.map(point => value(point.sample) ?? 0));
    const ceiling = Math.max(capacity ?? 0, peak * 1.08, 1);
    const x = at => 46 + (at - start) / windowMs * (right - 46);
    const y = amount => bottom - amount / ceiling * (bottom - 24);
    const nodes = document.createDocumentFragment();
    for (const fraction of [0, 0.5, 1]) {
        const level = ceiling * fraction;
        nodes.append(svgElement('line', {x1: 46, x2: right, y1: y(level), y2: y(level), class: 'chart-grid'}));
        nodes.append(svgElement('text', {x: 38, y: y(level) + 4, 'text-anchor': 'end', class: 'chart-label'}, level.toFixed(0)));
    }
    if (capacity) {
        nodes.append(svgElement('line', {x1: 46, x2: right, y1: y(capacity), y2: y(capacity), class: 'chart-limit'}));
        nodes.append(svgElement('text', {x: right, y: y(capacity) - 6, 'text-anchor': 'end', class: 'chart-label'}, `limit ${capacity.toFixed(0)}`));
    }
    let segment = [];
    const segments = [];
    let previous;
    for (const point of points) {
        const used = value(point.sample);
        if (point.breakBefore || (previous && point.at - previous.at > STALE_MS) || used === null) {
            if (segment.length) segments.push(segment);
            segment = [];
        }
        if (used !== null) segment.push([x(point.at), y(used)]);
        previous = point;
    }
    if (segment.length) segments.push(segment);
    for (const part of segments) {
        const path = part.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
        nodes.append(svgElement('path', {d: `${path} L${part.at(-1)[0]},${bottom} L${part[0][0]},${bottom} Z`, class: 'chart-area'}));
        nodes.append(svgElement('path', {d: path, class: 'chart-line'}));
        if (part.length === 1) nodes.append(svgElement('circle', {cx: part[0][0], cy: part[0][1], r: 3, class: 'chart-point'}));
    }
    for (const event of monitor.events.filter(event => (event.host === selected || event.kind === 'load') && event.at >= start && event.at <= end && ['kill', 'recovery', 'load'].includes(event.kind))) {
        nodes.append(svgElement('line', {x1: x(event.at), x2: x(event.at), y1: 20, y2: bottom, class: `chart-event ${event.kind}`}));
    }
    if (cursor) nodes.append(svgElement('line', {x1: x(cursor.at), x2: x(cursor.at), y1: 20, y2: bottom, class: 'chart-cursor'}));
    nodes.append(svgElement('text', {x: 46, y: height - 4, class: 'chart-label'}, `−${windowMs / 60000}m`));
    nodes.append(svgElement('text', {x: right, y: height - 4, 'text-anchor': 'end', class: 'chart-label'}, frozen ? clock(end) : 'now'));
    svg.replaceChildren(nodes);
    svg.setAttribute('aria-label', `${metric} history for ${selected}, peak ${peak.toFixed(1)} ${metric === 'memory' ? 'MiB' : 'millicores'}`);
    text(`${metric}-peak`, `Peak ${peak.toFixed(1)}${metric === 'memory' ? ' MiB' : 'm'}`);
}

function renderCharts(now) {
    const pod = monitor.pods.get(selected);
    const end = frozen?.at ?? now;
    const points = (frozen?.points ?? pod?.points ?? []).filter(point => point.at >= end - windowMs && point.at <= end);
    const index = inspected === null ? points.length - 1 : Math.min(inspected, points.length - 1);
    const cursor = points[index];
    const slider = $('history-scrubber');
    slider.max = Math.max(0, points.length - 1);
    slider.disabled = points.length < 2;
    slider.value = Math.max(index, 0);
    $('freeze-chart').textContent = frozen ? 'Resume charts' : 'Freeze charts';
    $('freeze-chart').setAttribute('aria-pressed', String(Boolean(frozen)));
    text('history-readout', cursor ? `${clock(cursor.at)} · ${number(cursor.sample.memory.used / MB)} MiB · ${number(cursor.sample.cpu.used === null ? null : cursor.sample.cpu.used * 1000)}m CPU${frozen ? ' · chart frozen, sampling continues' : ''}` : 'Collecting history…');
    drawChart('memory-chart', points, 'memory', end, cursor);
    drawChart('cpu-chart', points, 'cpu', end, cursor);
}

function renderIncident(now) {
    const incident = monitor.incident;
    $('incident').hidden = !incident;
    if (!incident) return;
    const labels = {requested: 'Kill request accepted', allocating: 'Memory is filling', unobserved: 'Waiting for the target to respond', restarted: 'Target restarted and responding', capped: 'Allocation capped · no container limit'};
    text('incident-phase', labels[incident.phase]);
    $('incident').dataset.phase = incident.phase;
    const elapsed = Math.floor(((incident.recoveredAt ?? now) - incident.at) / 1000);
    text('incident-detail', `${incident.host} · ${elapsed}s since request · observed peak ${number(incident.peakBytes / MB)} MiB. ${incident.phase === 'restarted' ? 'New process identity observed. Check Kubernetes for the termination reason.' : 'The timeline and charts keep the pre-restart history.'}`);
    if (['restarted', 'capped'].includes(incident.phase) && completedIncident !== incident) {
        completedIncident = incident;
        document.dispatchEvent(new CustomEvent('oom:complete', {detail: incident}));
    }
}

function render() {
    const now = Date.now();
    monitor.tick(now);
    renderPods(now);
    const pod = monitor.pods.get(selected);
    const stale = !pod || pod.stale;
    document.querySelector('.telemetry-stats').classList.toggle('is-stale', stale);
    const live = lastSuccess && now - lastSuccess <= STALE_MS && !latestError;
    text('stream-state', document.hidden ? 'Sampling paused · tab hidden' : latestError || (live ? '● Live · 1s sampling' : 'Waiting for telemetry…'));
    $('stream-state').classList.toggle('is-error', Boolean(latestError));
    if (pod) {
        const {memory, cpu} = pod.latest;
        text('memory-scope', memory.source === 'cgroup' ? 'app container memory' : 'process memory · RSS');
        text('memory-value', `${number(memory.used / MB)} MiB`);
        text('memory-detail', `${memory.limit ? `${number(memory.percent)}% of ${number(memory.limit / MB)} MiB` : 'No memory limit'}${stale ? ' · last known sample' : ''}`);
        text('cpu-scope', cpu.source === 'cgroup' ? 'app container cpu' : 'process cpu');
        text('cpu-value', `${number(cpu.used === null ? null : cpu.used * 1000)}m`);
        text('cpu-detail', cpu.used === null ? 'Warming up the CPU sample' : `${cpu.limit ? `${number(cpu.percent)}% of ${number(cpu.limit * 1000)}m` : 'No CPU limit'}${stale ? ' · last known sample' : ''}`);
        text('uptime-value', uptime(pod.latest.uptime));
        text('process-detail', `${pod.restarts} restart${pod.restarts === 1 ? '' : 's'} observed · ${Math.floor((now - pod.seenAt) / 1000)}s since sample`);
    } else {
        for (const id of ['memory-value', 'cpu-value', 'uptime-value']) text(id, '—');
        for (const id of ['memory-detail', 'cpu-detail', 'process-detail']) text(id, 'Waiting for this pod to respond');
    }
    renderCharts(now);
    renderIncident(now);
    if (lastEvent !== monitor.events[0]) {
        lastEvent = monitor.events[0];
        $('telemetry-events').replaceChildren(...monitor.events.slice(0, 10).map(event => {
            const row = element('li', `event-${event.kind}`);
            row.append(element('time', '', clock(event.at)), element('strong', '', event.message), element('span', '', event.host));
            return row;
        }));
    }
}

async function poll() {
    if (!document.hidden) {
        try {
            const response = await fetch('/status', {cache: 'no-store', signal: AbortSignal.timeout(3000)});
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const sample = await response.json();
            if (!sample.host || !sample.memory || !sample.cpu) throw new Error('Invalid telemetry response');
            monitor.ingest(sample);
            lastSuccess = Date.now();
            latestError = '';
        } catch (error) {
            latestError = `Telemetry unavailable · ${error.name === 'TimeoutError' ? 'request timeout' : error.message}`;
        }
    }
    render();
    setTimeout(poll, 1000);
}

$('pod-select').addEventListener('change', event => choose(event.target.value));
document.querySelectorAll('[data-window]').forEach(button => button.addEventListener('click', () => {
    windowMs = Number(button.dataset.window) * 1000;
    inspected = null;
    document.querySelectorAll('[data-window]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    render();
}));
$('freeze-chart').addEventListener('click', () => {
    frozen = frozen ? null : {at: Date.now(), points: [...(monitor.pods.get(selected)?.points ?? [])]};
    inspected = null;
    render();
});
$('history-scrubber').addEventListener('input', event => {
    frozen ??= {at: Date.now(), points: [...(monitor.pods.get(selected)?.points ?? [])]};
    inspected = Number(event.target.value);
    renderCharts(Date.now());
});
document.addEventListener('oom:start', event => {
    monitor.markOom(event.detail);
    choose(event.detail.host);
});
document.addEventListener('load:start', event => {
    const responding = [...monitor.pods.values()].filter(pod => !pod.stale).length;
    loadRun = {baseline: responding, peak: responding};
    monitor.record('service', `HPA load started · ${event.detail.concurrency} concurrent requests · ${event.detail.seconds}s`, 'load', Date.now());
    frozen = null;
    inspected = null;
    render();
});
document.addEventListener('load:stop', () => {
    monitor.record('service', 'HPA load stopped · watch CPU and pod count settle', 'load', Date.now());
    render();
});
document.addEventListener('visibilitychange', render);
window.addEventListener('resize', render);
poll();
