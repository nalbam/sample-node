/**
 * dropper.js
 */

/* global rate */ // injected by views/drop.ejs

class Dropper {
    constructor() {
        this.init();
    }

    init() {
        var canvas = document.getElementById("drop-canvas");
        if (canvas === null) {
            var width = window.innerWidth;
            var height = window.innerHeight;
            canvas = document.createElement("canvas");
            canvas.setAttribute("id", "drop-canvas");
            canvas.setAttribute("style", "display:block;z-index:999999;pointer-events:none;position:fixed;top:0");
            document.body.prepend(canvas);
            canvas.width = width;
            canvas.height = height;
            window.addEventListener("resize", function () {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
            }, true);
        }

        this.debug = false;

        this.canvas = canvas;
        this.context = canvas.getContext("2d");

        this.particles = [];
        this.versions = [];

        // Colors live here for the lifetime of the page. Holding them in
        // `versions` lost a version's color whenever its last dot landed, so a
        // version that paused came back in a different color.
        this.palette = new Map();

        // DodgerBlue, DarkOrange, ForestGreen, MediumPurple
        this.colors = ["30,144,255", "255,140,0", "34,139,34", "147,112,219"];
        this.error = "220,20,60"; // Crimson
        this.color_index = -1;

        this.interval = 100;

        this.column = 50;
        this.radius = 10;
        this.alpha = 0.9;
        // Pixels per millisecond. Slow enough that ~30 dots share the screen,
        // so the version split is a usable sample rather than 8 dots jittering.
        this.speed = 0.3;

        this.columns = [];
        for (var i = 0; i < this.column; i++) {
            this.columns.push(i);
        }
        this.columns.sort(function () {
            return 0.5 - Math.random()
        });
        this.column_index = -1;
    }

    start() {
        if (!this.time) {
            this.time = performance.now();
        }

        if (!this.running) {
            this.running = true;
            requestAnimationFrame(this.step.bind(this));
        }
    }

    step(timestamp) {
        if (!this.running) {
            return;
        }

        // Cap the step so dots do not teleport after the tab was backgrounded,
        // where requestAnimationFrame stops firing.
        var diff = Math.min(timestamp - this.time, 100);
        this.time = timestamp;

        this.draw(diff);

        requestAnimationFrame(this.step.bind(this));
    }

    draw(diff) {
        var width = window.innerWidth;
        var height = window.innerHeight;
        var column = parseInt(width / (this.radius * 3));
        var padding = parseInt(width / 6);

        this.context.clearRect(0, 0, width, height);

        var particle;
        var x;

        for (var i = 0; i < this.particles.length; i++) {
            particle = this.particles[i];

            particle.y += (diff * this.speed);
            if (particle.y > height) {
                this.del(particle.v, i);
                i--;
                continue;
            }

            x = parseInt(column / this.column * particle.x) * (this.radius * 2) + padding;

            this.context.beginPath();
            this.context.arc(x, particle.y, particle.r, 0, 2 * Math.PI);
            this.context.fillStyle = particle.color;
            this.context.fill();
        }
    }

    find(v) {
        var version;
        var index = -1;
        for (var i = 0; i < this.versions.length; i++) {
            version = this.versions[i];
            if (version.v === v) {
                index = i;
                break;
            }
        }
        // console.log(`find ${index}`);
        return index;
    }

    // A version keeps its color for as long as the page is open. Failures are
    // always the error color and never take a palette slot.
    color(v) {
        if (!v) {
            return `rgba(${this.error},${this.alpha})`;
        }

        var color = this.palette.get(v);
        if (!color) {
            this.color_index = (this.color_index + 1) % this.colors.length;
            color = `rgba(${this.colors[this.color_index]},${this.alpha})`;
            this.palette.set(v, color);
        }

        return color;
    }

    // `versions` counts what is on screen right now, which is what the split
    // bar reads. It empties out as dots land; the palette above does not.
    count(v) {
        var index = this.find(v);

        if (index > -1) {
            this.versions[index].x++;
        } else {
            this.versions.push({ v: v, c: this.color(v), x: 1 });
        }

        if (this.debug) {
            console.log(`version ${this.versions.length} ${v}`);
        }
    }

    del(v, i) {
        this.particles.splice(i, 1);

        var index = this.find(v);
        if (index > -1) {
            var version = this.versions[index];

            version.x--;

            if (version.x <= 0) {
                this.versions.splice(index, 1);
            }
        }
    }

    gen() {
        this.column_index = (this.column_index + 1) % this.columns.length;

        return this.columns[this.column_index];
    }

    add(v) {
        var particle = {};

        particle.v = v;
        particle.x = this.gen();
        particle.y = this.radius * -1;
        particle.r = this.radius;
        particle.color = this.color(v);

        this.count(v);
        this.particles.push(particle);

        if (this.debug) {
            console.log(`drop ${this.particles.length} ${particle.x} ${particle.y} ${v}`);
        }
    }

    progress() {
        var e = document.getElementById("drop-rate");
        if (e) {
            var version;
            var width;
            var t = '<div class="progress">';
            for (var i = 0; i < this.versions.length; i++) {
                version = this.versions[i];
                width = version.x * 100 / this.particles.length;
                t += `<div class="progress-bar" role="progressbar" style="width:${width}%; background-color: ${version.c};"></div>`;
            }
            t += '</div>';
            e.innerHTML = t;
        }
    }
}

let dropper = new Dropper();

dropper.start();

function health() {
    var ms = Date.now();
    var url = `${location.protocol}//${location.host}/success/${rate}?q=${ms}`;
    fetch(url)
        .then(function (res) {
            // A 500 from /success/:rate is a failed drop, not an exception.
            return res.ok ? res.json() : null;
        })
        .then(function (res) {
            dropper.add(res ? res.version : null);
        })
        .catch(function () {
            dropper.add(null);
        });
}

setInterval(function () {
    // requestAnimationFrame stops in a background tab, so polling on would pile
    // up dots nothing is drawing or removing.
    if (!document.hidden) {
        health();
    }
}, dropper.interval);

setInterval(function () {
    dropper.progress();
}, 1000);
