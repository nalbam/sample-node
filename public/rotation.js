/**
 * Shows which versions are answering behind the service.
 *
 * The page itself is one pod, so this polls /health to sample whatever the load
 * balancer hands back. The bar stays hidden until a second version shows up —
 * during a rollout it appears on its own, and outside one there is nothing to
 * say.
 */

const ROTATION_WINDOW = 20;
const ROTATION_INTERVAL = 3000;

// Same order as dropper.js, so a version reads the same on both screens.
const ROTATION_COLORS = ["30,144,255", "255,140,0", "34,139,34", "147,112,219"];

let _seen = [];
let _assigned = new Map();
let _next = -1;

function _color(version) {
    let color = _assigned.get(version);

    if (!color) {
        _next = (_next + 1) % ROTATION_COLORS.length;
        color = `rgba(${ROTATION_COLORS[_next]},0.9)`;
        _assigned.set(version, color);
    }

    return color;
}

function _render() {
    let el = document.getElementById('rotation');
    if (!el) {
        return;
    }

    let counts = new Map();
    _seen.forEach(function (version) {
        counts.set(version, (counts.get(version) || 0) + 1);
    });

    if (counts.size < 2) {
        el.hidden = true;
        return;
    }

    let bars = document.createDocumentFragment();
    let legend = document.createDocumentFragment();

    counts.forEach(function (n, version) {
        let share = n * 100 / _seen.length;
        let color = _color(version);

        let bar = document.createElement('div');
        bar.className = 'progress-bar';
        bar.style.width = `${share}%`;
        bar.style.backgroundColor = color;
        bars.appendChild(bar);

        let swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.backgroundColor = color;

        // Built as nodes rather than markup: the version string comes from the
        // server and never goes near innerHTML.
        let item = document.createElement('span');
        item.className = 'rotation-item';
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(`${version} ${Math.round(share)}%`));
        legend.appendChild(item);
    });

    let sampled = document.createElement('span');
    sampled.className = 'rotation-item';
    sampled.textContent = `${_seen.length} sampled`;
    legend.appendChild(sampled);

    let progress = el.querySelector('.progress');
    progress.textContent = '';
    progress.appendChild(bars);

    let legendEl = el.querySelector('.rotation-legend');
    legendEl.textContent = '';
    legendEl.appendChild(legend);

    el.hidden = false;
}

function _sample() {
    fetch('/health')
        .then(function (res) {
            // A 500 from FAULT_RATE still names the version that served it.
            return res.json();
        })
        .then(function (res) {
            if (res && res.version) {
                _seen.push(res.version);
                if (_seen.length > ROTATION_WINDOW) {
                    _seen.shift();
                }
                _render();
            }
        })
        .catch(function () {
            // Sampling is best effort; a missed poll just keeps the last bar.
        });
}

document.addEventListener('DOMContentLoaded', function () {
    _sample();
    setInterval(function () {
        if (!document.hidden) {
            _sample();
        }
    }, ROTATION_INTERVAL);
});
