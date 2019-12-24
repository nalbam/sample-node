var drop = {
	maxCount: 500,
	interval: 10,
	frameInterval: 15,
	speed: 2,
	alpha: 1.0,
	start: null
};

(function () {
	drop.start = startDrop;

	var animationTimer = null;
	var lastFrameTime = Date.now();
	var context = null;

	var versions = [];
	var particles = [];
	var pointer = 0;

	function health() {
		let url = `${location.protocol}//${location.host}/health`;
		$.ajax({
			url: url,
			type: 'get',
			success: function (res, status) {
				// console.log(`health : ${status}`);
				if (res) {
					resetParticle(res.version);
				}
			}
		});

		// window.setTimeout(health, drop.interval);
	}

	function getColor(v) {
		var version;
		var color;

		for (var i = 0; i < versions.length; i++) {
			version = versions[i];
			if (version.v == v) {
				color = version.c;
				break;
			}
		}

		if (!color) {
			color = `rgba(${Math.random() * 250},${Math.random() * 250},${Math.random() * 250},${drop.alpha})`;
			version = {};
			version.v = v;
			version.c = color;
			versions.push(version);
		}

		return color;
	}

	function resetParticle(version) {
		var width = window.innerWidth;
		var height = window.innerHeight;
		var particle;

		if (pointer >= drop.maxCount) {
			pointer = 0;
		}

		if (particles.length <= pointer) {
			particle = {};
			// particles.push(particle);
		} else {
			particle = particles[pointer];
		}

		particle.x = parseInt(Math.random() * width);
		particle.y = -height;
		particle.color = getColor(version);
		particle.diameter = 20; // Math.random() * 5 + 10;

		if (particles.length <= pointer) {
			particles.push(particle);
		}

		// console.log(`drop ${ pointer}/${particles.length} ${particle.x} ${particle.y}`);

		pointer++;
	}

	function runAnimation() {
		var now = Date.now();
		var delta = now - lastFrameTime;
		if (delta > drop.frameInterval) {
			context.clearRect(0, 0, window.innerWidth, window.innerHeight);
			updateParticles();
			drawParticles(context);
			lastFrameTime = now - (delta % drop.frameInterval);
		}
		animationTimer = requestAnimationFrame(runAnimation);
	}

	function startDrop() {
		var width = window.innerWidth;
		var height = window.innerHeight;

		window.requestAnimationFrame = (function () {
			return window.requestAnimationFrame ||
				window.webkitRequestAnimationFrame ||
				window.mozRequestAnimationFrame ||
				window.oRequestAnimationFrame ||
				window.msRequestAnimationFrame ||
				function (callback) {
					return window.setTimeout(callback, drop.frameInterval);
				};
		})();

		var canvas = document.getElementById("drop-canvas");
		if (canvas === null) {
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
			context = canvas.getContext("2d");
		} else if (context === null) {
			context = canvas.getContext("2d");
		}

        setInterval(function () {
            health();
        }, drop.interval);

		runAnimation();
	}

	function drawParticles(context) {
		var particle;
		var x, y, x2, y2;
		for (var i = 0; i < particles.length; i++) {
			particle = particles[i];
			// particle.y += (particle.diameter + drop.speed) * 0.5;

			x2 = particle.x;
			x = x2 + particle.diameter / 2;
			y = particle.y;
			y2 = y + particle.diameter / 2;

			context.beginPath();
			context.lineWidth = particle.diameter;
			context.strokeStyle = particle.color;
			context.moveTo(x, y);
			context.lineTo(x2, y2);
			context.stroke();
		}
	}

	function updateParticles() {
		var particle;
		for (var i = 0; i < particles.length; i++) {
			particle = particles[i];
			particle.y += (particle.diameter + drop.speed) * 0.5;
		}
	}
})();

drop.start();
