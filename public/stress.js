/**
 * Drives the CPU load switch.
 *
 * An HPA scales on the average across pods, so one busy pod out of two only
 * moves the average halfway. Each press is therefore spread over several
 * requests — the load balancer decides where each lands, and the pod list is
 * what shows where they actually did.
 */

/* global podCount */ // defined in public/pods.js

// Three requests per pod makes it very likely every pod gets at least one.
const LOAD_SPREAD = 3;
const LOAD_GAP_MS = 100;

let _generation = 0;

function _clock(seconds) {
    let m = Math.floor(seconds / 60);
    let s = seconds % 60;

    return `${m}:${String(s).padStart(2, '0')}`;
}

function _spread(request) {
    // Each press supersedes the last. Without this the tail of a stop can land
    // after the start that followed it and cancel it — background tabs throttle
    // setTimeout to a second, which makes that tail long.
    let mine = ++_generation;

    // pods.js owns the list; fall back to a single call before it has answered.
    let pods = typeof podCount === 'function' ? podCount() : 1;
    let calls = Math.max(pods, 1) * LOAD_SPREAD;
    let sent = 0;

    function next() {
        if (mine !== _generation || sent >= calls) {
            return;
        }

        sent += 1;
        request().catch(function () {
            // One lost call out of several does not change the outcome.
        });
        setTimeout(next, LOAD_GAP_MS);
    }

    next();
}

document.addEventListener('DOMContentLoaded', function () {
    let button = document.querySelector('.load-btn');
    let face = button.querySelector('.load-face');
    let range = document.querySelector('.load-range');
    let seconds = 60;
    let ticker = null;
    let remaining = 0;

    function idle() {
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
            _spread(function () {
                return fetch('/stress', { method: 'DELETE' });
            });
            idle();
            return;
        }

        _spread(function () {
            return fetch(`/stress/${seconds}`, { method: 'POST' });
        });

        remaining = seconds;
        button.classList.add('is-on');
        face.textContent = _clock(remaining);
        ticker = setInterval(countdown, 1000);
    });

    idle();
});
