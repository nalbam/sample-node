export const STALE_MS = 10000;
export const HISTORY_MS = 5 * 60 * 1000;

// Keep observations across process restarts. A missed load-balanced sample is
// not evidence of OOM; only a changed process identity proves a restart here.
export function createMonitor() {
    const pods = new Map();
    const events = [];
    let incident = null;

    function event(host, message, kind, at) {
        events.unshift({host, message, kind, at});
        events.splice(50);
    }

    function ingest(sample, at = Date.now()) {
        let pod = pods.get(sample.host);
        if (!pod) {
            pod = {host: sample.host, latest: null, points: [], restarts: 0, stale: false, high: false};
            pods.set(sample.host, pod);
            event(sample.host, 'Pod discovered', 'info', at);
        }
        const before = pod.latest;
        const targetRestarted = incident?.host === sample.host && sample.instanceId && incident.instanceId
            && sample.instanceId !== incident.instanceId;
        const restarted = before ? ((before.instanceId && sample.instanceId && before.instanceId !== sample.instanceId)
            || sample.uptime + 3 < before.uptime) : targetRestarted;
        if (restarted) {
            pod.restarts++;
            pod.high = false;
            event(sample.host, 'Process restarted', 'recovery', at);
        } else if (pod.stale) {
            event(sample.host, 'Samples resumed', 'recovery', at);
        }
        if (sample.memory.percent >= 90 && !pod.high) {
            event(sample.host, 'Memory reached 90% of limit', 'warning', at);
            pod.high = true;
        } else if (sample.memory.percent < 80) {
            pod.high = false;
        }
        pod.points.push({at, sample, breakBefore: Boolean(restarted || pod.stale)});
        pod.latest = sample;
        pod.seenAt = at;
        pod.stale = false;
        if (incident?.host === sample.host) {
            if (!['restarted', 'capped'].includes(incident.phase)) incident.peakBytes = Math.max(incident.peakBytes, sample.memory.used);
            if (targetRestarted) {
                if (incident.phase !== 'restarted') event(sample.host, 'Kill target is responding after restart', 'recovery', at);
                incident.phase = 'restarted';
                incident.recoveredAt ??= at;
            } else if (sample.oom?.capped) {
                incident.phase = 'capped';
            } else if (sample.oom?.active) {
                incident.phase = 'allocating';
            }
        }
        tick(at);
        return pod;
    }

    function tick(at = Date.now()) {
        for (const pod of pods.values()) {
            pod.points = pod.points.filter(point => at - point.at <= HISTORY_MS);
            if (!pod.stale && at - pod.seenAt > STALE_MS) {
                pod.stale = true;
                event(pod.host, 'No recent sample — availability unknown', 'warning', at);
            }
        }
        if (incident && !['restarted', 'capped'].includes(incident.phase)
            && at - (pods.get(incident.host)?.seenAt ?? incident.at) > STALE_MS) {
            incident.phase = 'unobserved';
        }
        // Bound a long-running browser session even while a deployment adds pods.
        if (pods.size > 24) {
            const oldest = [...pods.values()].filter(pod => pod.host !== incident?.host)
                .sort((a, b) => a.seenAt - b.seenAt);
            for (const pod of oldest.slice(0, pods.size - 24)) pods.delete(pod.host);
        }
    }

    function markOom(target, at = Date.now()) {
        incident = {host: target.host, instanceId: target.instanceId, at, phase: 'requested',
            peakBytes: pods.get(target.host)?.latest?.memory.used ?? 0};
        event(target.host, 'Kill switch accepted · OOM allocation requested', 'kill', at);
    }

    return {pods, events, ingest, tick, markOom, record: event, get incident() { return incident; }};
}
