/**
 * dropper.js
 */

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

        this.canvas = canvas;
        this.context = canvas.getContext("2d");

        this.particles = [];
        this.versions = [];

        // DodgerBlue, DarkOrange, ForestGreen, MediumPurple
        this.colors = ["30,144,255", "255,140,0", "34,139,34", "147,112,219"];
        this.error = "220,20,60"; // Crimson

        this.interval = 10;

        this.radius = 10;
        this.alpha = 0.9;
        this.speed = 1;
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

        var diff = timestamp - this.time;
        this.time = timestamp;

        this.draw(diff);

        requestAnimationFrame(this.step.bind(this));
    }

    draw(diff) {
        var width = window.innerWidth;
        var height = window.innerHeight;

        var particle;

        this.context.clearRect(0, 0, width, height);

        for (var i = 0; i < this.particles.length; i++) {
            particle = this.particles[i];

            particle.y += (diff * this.speed);

            if (particle.y > height) {
                this.del(particle.v, i);
                i--;
                continue;
            }

            this.context.beginPath();
            this.context.arc(particle.x, particle.y, particle.r, 0, 2 * Math.PI);
            this.context.fillStyle = particle.color;
            this.context.fill();
        }
    }

    find(v) {
        var version;
        for (var i = 0; i < this.versions.length; i++) {
            version = this.versions[i];
            if (version.v === v) {
                version.i = i;
                break;
            }
        }
        return version;
    }

    color(v) {
        var version = this.find(v);
        var color;

        if (version) {
            color = version.c;

            version.x++;
        } else {
            if (v) {
                if (this.color_index) {
                    this.color_index++;
                    if (this.color_index >= this.colors.length) {
                        this.color_index = this.color_index % this.colors.length;
                    }
                } else {
                    this.color_index = parseInt(Math.random() * this.colors.length);
                }
                color = `rgba(${this.colors[this.color_index]},${this.alpha})`;
            } else {
                color = `rgba(${this.error},${this.alpha})`;
            }

            version = {};
            version.v = v;
            version.c = color;
            version.x = 1;

            this.versions.push(version);
        }

        console.log(`version ${this.versions.length} ${version.i} ${version.x}`);

        return color;
    }

    del(v, i) {
        this.particles.splice(i, 1);

        var version = this.find(v);

        if (version) {
            version.x--;

            if (version.x <= 0) {
                this.versions.splice(version.i, 1);
            }
        }
    }

    add(v) {
        var width = window.innerWidth;
        var column = parseInt(width / (this.radius * 3));

        var particle = {};

        particle.v = v;
        particle.x = parseInt(Math.random() * column) * (this.radius * 2) + parseInt(width / 6);
        particle.y = this.radius * -1;
        particle.r = this.radius;
        particle.color = this.color(v);

        this.particles.push(particle);

        console.log(`drop ${this.particles.length} ${particle.x} ${particle.y}`);
    }
}

let dropper = new Dropper();

dropper.start();

function health() {
    var url = `${location.protocol}//${location.host}/health`;
    $.ajax({
        url: url,
        type: 'get',
        success: function (res, status) {
            // console.log(`health : ${status}`);
            if (res) {
                dropper.add(res.version);
            } else {
                dropper.add(null);
            }
        },
        error: function (err) {
            dropper.add(null);
        }
    });
}

setInterval(function () {
    health();
}, dropper.interval);
