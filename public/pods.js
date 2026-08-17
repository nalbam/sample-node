/**
 * Lists the pods answering behind the service.
 *
 * The page is served by one pod, so this samples /status repeatedly and keeps
 * whatever the load balancer hands back. Only pods that answer show up — a
 * Pending or CrashLoopBackOff pod is visible as a smaller count, not a row.
 */

const PODS_INTERVAL = 2000;
const PODS_TTL = 20000;

// Same order as dropper.js, so a version reads the same on both screens.
const POD_COLORS = ["30,144,255", "255,140,0", "34,139,34", "147,112,219"];

let _pods = new Map();
let _assigned = new Map();
let _next = -1;

function _color(version) {
    let color = _assigned.get(version);

    if (!color) {
        _next = (_next + 1) % POD_COLORS.length;
        color = `rgba(${POD_COLORS[_next]},0.9)`;
        _assigned.set(version, color);
    }

    return color;
}

function _uptime(seconds) {
    if (seconds < 60) {
        return `${seconds}s`;
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)}m`;
    }
    return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function _metric(label, percent) {
    let el = document.createElement('span');
    el.className = 'pod-metric';

    let tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = label;
    el.appendChild(tag);

    // No limit means no percentage to draw against, so the meter is left out
    // rather than shown empty.
    if (percent !== null) {
        let meter = document.createElement('span');
        meter.className = 'meter';

        let fill = document.createElement('i');
        fill.style.width = `${Math.min(percent, 100)}%`;
        if (percent >= 90) {
            fill.className = 'is-high';
        }

        meter.appendChild(fill);
        el.appendChild(meter);
    }

    let value = document.createElement('span');
    value.className = 'pod-value';
    value.textContent = percent === null ? 'no limit' : `${percent}%`;
    el.appendChild(value);

    return el;
}

function _row(pod) {
    let row = document.createElement('div');
    row.className = 'pod';

    let swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.backgroundColor = _color(pod.version);
    row.appendChild(swatch);

    // Built as nodes, not markup: host and version come from the server.
    let host = document.createElement('span');
    host.className = 'pod-host';
    host.textContent = pod.host;
    row.appendChild(host);

    let version = document.createElement('span');
    version.className = 'pod-version';
    version.textContent = pod.version;
    row.appendChild(version);

    let stats = document.createElement('div');
    stats.className = 'pod-stats';

    let up = document.createElement('span');
    up.className = 'pod-up';
    up.textContent = `up ${_uptime(pod.uptime)}`;
    stats.appendChild(up);

    stats.appendChild(_metric('mem', pod.memory.percent));
    stats.appendChild(_metric('cpu', pod.cpu.percent));

    row.appendChild(stats);

    return row;
}

function _render() {
    let el = document.getElementById('pods');
    if (!el) {
        return;
    }

    let now = Date.now();
    _pods.forEach(function (pod, host) {
        if (now - pod.seenAt > PODS_TTL) {
            _pods.delete(host);
        }
    });

    let list = Array.from(_pods.values()).sort(function (a, b) {
        return a.host.localeCompare(b.host);
    });

    if (list.length === 0) {
        el.hidden = true;
        return;
    }

    el.querySelector('.pods-count').textContent = `${list.length} responding`;

    let rows = document.createDocumentFragment();
    list.forEach(function (pod) {
        rows.appendChild(_row(pod));
    });

    let body = el.querySelector('.pods-body');
    body.textContent = '';
    body.appendChild(rows);

    el.hidden = false;
}

function _sample() {
    fetch('/status')
        .then(function (res) {
            return res.ok ? res.json() : null;
        })
        .then(function (pod) {
            if (pod && pod.host) {
                pod.seenAt = Date.now();
                _pods.set(pod.host, pod);
                _render();
            }
        })
        .catch(function () {
            // Sampling is best effort; a missed poll keeps the last rows.
        });
}

document.addEventListener('DOMContentLoaded', function () {
    _sample();
    setInterval(function () {
        if (!document.hidden) {
            _sample();
        }
    }, PODS_INTERVAL);
});
