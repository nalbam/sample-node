var dropper = {
	maxCount: 500,
	interval: 10,
	frameInterval: 15,
	radius: 10,
	speed: 10,
	alpha: 0.8,
	start: null
};

(function () {
	dropper.start = startDrop;

	var animationTimer = null;
	var lastFrameTime = Date.now();
	var context = null;

	// https://www.html.am/html-codes/color/color-scheme.cfm
	// SteelBlue, ForestGreen, DarkOrange, SlateGray, DeepPink, DarkCyan, Crimson
	var colors = ["70,130,180", "34,139,34", "255,140,0", "112,128,144", "255,20,147", "0,139,139", "220,20,60"];

	var particles = [];
	var i_particle = -1;

	var versions = [];
	var i_version = parseInt(Math.random() * colors.length);

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

		// window.setTimeout(health, dropper.interval);
	}

	function getColor(v) {
		var version;
		var color;

		for (var i = 0; i < versions.length; i++) {
			version = versions[i];
			if (version.v == v) {
				i_version = i;
				color = version.c;
				break;
			}
		}

		if (!color) {
			i_version++;
			if (i_version >= colors.length) {
				i_version = i_version % colors.length;
			}

			color = `rgba(${colors[i_version]},${dropper.alpha})`;

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

		i_particle++;
		if (i_particle >= dropper.maxCount) {
			i_particle = 0;
		}

		if (particles.length <= i_particle) {
			particle = {};
			// particles.push(particle);
		} else {
			particle = particles[i_particle];
		}

		particle.x = parseInt(Math.random() * width);
		particle.y = dropper.radius * -2;
		particle.r = dropper.radius;
		particle.color = getColor(version);

		if (particles.length <= i_particle) {
			particles.push(particle);
		}

		// console.log(`drop ${i_particle}/${particles.length} ${particle.x} ${particle.y}`);
	}

	function runAnimation() {
		context.clearRect(0, 0, window.innerWidth, window.innerHeight);

		var particle;

		for (var i = 0; i < particles.length; i++) {
			particle = particles[i];
			particle.y += dropper.speed;

			context.beginPath();
			context.arc(particle.x, particle.y, particle.r, 0, 2 * Math.PI);
			context.fillStyle = particle.color;
			context.fill();
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
					return window.setTimeout(callback, dropper.frameInterval);
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
		}, dropper.interval);

		runAnimation();
	}
})();

dropper.start();