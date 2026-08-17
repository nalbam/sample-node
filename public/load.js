/**
 * Drives the load switch.
 *
 * Rather than telling a pod to burn its own CPU, this sends a steady stream of
 * requests at the service and lets the pods spend CPU answering them. The load
 * balancer decides where each one lands, so every pod carries a share — and
 * because the total is fixed, that share falls when an HPA scales up. The pod
 * list is where you watch it happen.
 */

// 20 req/s x 50ms = 1.0 core of work in total, however many pods are answering.
const LOAD_TICK_MS = 50;
const LOAD_WORK_MS = 50;

// A browser opens about six connections per host, so anything past that queues
// in the browser instead of reaching a pod. Skipping a tick when the requests
// are already in flight also lets the rate fall on its own when the cluster
// cannot keep up, rather than piling on.
const LOAD_MAX_INFLIGHT = 6;

let _pump = null;
let _inflight = 0;

function _clock(seconds) {
    let m = Math.floor(seconds / 60);
    let s = seconds % 60;

    return `${m}:${String(s).padStart(2, '0')}`;
}

function _send() {
    if (_inflight >= LOAD_MAX_INFLIGHT) {
        return;
    }

    _inflight += 1;
    fetch(`/work/${LOAD_WORK_MS}`)
        .catch(function () {
            // One lost call out of twenty a second does not change the outcome.
        })
        .then(function () {
            _inflight -= 1;
        });
}

function _start() {
    if (!_pump) {
        _pump = setInterval(_send, LOAD_TICK_MS);
    }
}

function _stop() {
    clearInterval(_pump);
    _pump = null;
}

document.addEventListener('DOMContentLoaded', function () {
    let button = document.querySelector('.load-btn');
    let face = button.querySelector('.load-face');
    let range = document.querySelector('.load-range');
    let seconds = 60;
    let ticker = null;
    let remaining = 0;

    function idle() {
        _stop();
        clearInterval(ticker);
        ticker = null;
        remaining = 0;
        face.textContent = 'load';
        button.classList.remove('is-on');
    }

    function countdown() {
        remaining -= 1;
        if (remaining <= 0) {
            idle();
            return;
        }
        face.textContent = _clock(remaining);
    }

    range.addEventListener('click', function (event) {
        let pick = event.target.closest('.range');
        if (!pick) {
            return;
        }

        seconds = parseInt(pick.dataset.seconds, 10);
        range.querySelectorAll('.range').forEach(function (el) {
            el.classList.toggle('is-on', el === pick);
        });
    });

    button.addEventListener('click', function () {
        if (ticker) {
            idle();
            return;
        }

        _start();

        remaining = seconds;
        button.classList.add('is-on');
        face.textContent = _clock(remaining);
        ticker = setInterval(countdown, 1000);
    });

    idle();
});
