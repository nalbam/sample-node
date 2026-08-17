/**
 * Drives the load switch.
 *
 * Rather than telling a pod to burn its own CPU, this sends a steady stream of
 * requests at the service and lets the pods spend CPU answering them. The load
 * balancer decides where each one lands, so every pod carries a share — and
 * because the total is fixed, that share falls when an HPA scales up. The pod
 * list is where you watch it happen.
 */

// Each request burns 100ms, so one of them in flight at all times is about one
// core kept busy and the level mark is simply how many to keep in flight. The
// round trip eats into that a little: a 20ms hop delivers 100/120 of a core per
// request, which is why the marks are a target rather than a promise.
const LOAD_WORK_MS = 100;

// Refilling on completion instead of on a timer is what keeps the load up while
// you watch kubectl in another window: a hidden tab throttles timers to about
// once a second, and to once a minute after five minutes, which would leave the
// switch latched down sending almost nothing. Network callbacks keep running.
const LOAD_RETRY_MS = 250;

let _until = 0;
let _inflight = 0;
let _cores = 4;

function _clock(seconds) {
    let m = Math.floor(seconds / 60);
    let s = seconds % 60;

    return `${m}:${String(s).padStart(2, '0')}`;
}

function _remaining() {
    return Math.max(Math.ceil((_until - Date.now()) / 1000), 0);
}

// Tops the requests back up to the level, and every completion calls back in.
// The deadline is checked here rather than left to the countdown, so a throttled
// timer cannot leave the load running long after its time is up.
function _fill() {
    while (_inflight < _cores && Date.now() < _until) {
        _inflight += 1;
        fetch(`/work/${LOAD_WORK_MS}`)
            .then(function () {
                return 0;
            }, function () {
                // Nothing is answering. Wait a beat rather than spinning on a
                // connection that fails the moment it is made.
                return LOAD_RETRY_MS;
            })
            .then(function (wait) {
                _inflight -= 1;
                if (wait) {
                    setTimeout(_fill, wait);
                } else {
                    _fill();
                }
            });
    }
}

function _start(seconds) {
    _until = Date.now() + seconds * 1000;
    _fill();
}

function _stop() {
    _until = 0;
}

// Where the marks are remembered. A demo runs off one browser over and over,
// and picking 10m and 8x again after every reload is a tax on whoever is
// presenting. Storage is per origin, so each cluster's page keeps its own.
const LOAD_STORE = 'sample-node.load';

function _stored() {
    try {
        return JSON.parse(localStorage.getItem(LOAD_STORE)) || {};
    } catch {
        // Storage can be turned off and the value can be anything a previous
        // version left behind. Either way the markup's own marks are the
        // fallback, so there is nothing to repair here.
        return {};
    }
}

function _remember(key, value) {
    let all = _stored();
    all[key] = value;

    try {
        localStorage.setItem(LOAD_STORE, JSON.stringify(all));
    } catch {
        // Full, or off. The switch still works, it just forgets.
    }
}

// The marks under the button are two rows of the same thing: pick one, it
// lights, and the caller keeps whatever it stands for. `key` names both the
// data attribute the marks carry and the field they are remembered under.
//
// The starting mark comes from storage when it is still one of the marks on
// offer, and from the markup otherwise — which covers a first visit and a
// remembered value that no longer exists.
function _marks(row, key, choose) {
    let marks = Array.from(row.querySelectorAll('.range'));
    let saved = _stored()[key];

    function light(pick) {
        marks.forEach(function (el) {
            el.classList.toggle('is-on', el === pick);
        });
        choose(pick);
    }

    let start = marks.find(function (el) {
        return el.dataset[key] === saved;
    }) || marks.find(function (el) {
        return el.classList.contains('is-on');
    });

    if (start) {
        light(start);
    }

    row.addEventListener('click', function (event) {
        let pick = event.target.closest('.range');
        if (!pick) {
            return;
        }

        light(pick);
        _remember(key, pick.dataset[key]);
    });
}

document.addEventListener('DOMContentLoaded', function () {
    let button = document.querySelector('.load-btn');
    let face = button.querySelector('.load-face');
    let seconds = 60;
    let ticker = null;

    function idle() {
        _stop();
        clearInterval(ticker);
        ticker = null;
        face.textContent = 'load';
        button.classList.remove('is-on');
    }

    function countdown() {
        let left = _remaining();
        if (left <= 0) {
            idle();
            return;
        }
        face.textContent = _clock(left);
    }

    _marks(document.querySelector('.load-time'), 'seconds', function (pick) {
        seconds = parseInt(pick.dataset.seconds, 10);
    });

    // Read on every refill, so turning it up reaches the pods without a restart.
    _marks(document.querySelector('.load-level'), 'cores', function (pick) {
        _cores = parseInt(pick.dataset.cores, 10);
    });

    button.addEventListener('click', function () {
        if (ticker) {
            idle();
            return;
        }

        _start(seconds);

        button.classList.add('is-on');
        face.textContent = _clock(_remaining());
        ticker = setInterval(countdown, 1000);
    });

    idle();
});
