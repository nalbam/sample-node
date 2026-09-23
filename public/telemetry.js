export const STALE_MS = 10000;
export const HISTORY_MS = 5 * 60 * 1000;

export function averageSamples(samples) {
    function metric(name) {
        const values = samples.map(sample => sample[name]).filter(value => Number.isFinite(value.used));
        const mean = field => values.length ? values.reduce((sum, value) => sum + value[field], 0) / values.length : null;
        const used = mean('used');
        const limit = values.length && values.every(value => Number.isFinite(value.limit) && value.limit > 0) ? mean('limit') : null;
        return {used, limit, percent: limit ? used / limit * 100 : null,
            source: values.every(value => value.source === 'cgroup') ? 'cgroup' : 'process'};
    }
    return {memory: metric('memory'), cpu: metric('cpu')};
}

// Align the latest fresh recording from each pod on the same one-second grid.
// A partial second or a jittering publisher must not change a pod's weight.
export function averageHistory(pods) {
    const points = [...pods].flatMap(pod => pod.points.map(point => ({...point, host: pod.host})))
        .sort((a, b) => a.at - b.at);
    if (!points.length) return [];
    const latest = new Map();
    const history = [];
    let index = 0;
    const end = Math.floor(points.at(-1).at / 1000) * 1000;
    for (let at = Math.ceil(points[0].at / 1000) * 1000; at <= end; at += 1000) {
        while (index < points.length && points[index].at <= at) {
            const point = points[index++];
            latest.set(point.host, point);
        }
        if (index > 0 && index < points.length && points[index].at - points[index - 1].at > STALE_MS
            && at > points[index - 1].at) continue;
        const fresh = [...latest.values()].filter(point => at - point.at <= STALE_MS);
        if (fresh.length) history.push({at, sample: averageSamples(fresh.map(point => point.sample)), breakBefore: false});
    }
    return history;
}

// Samples retain their Redis recording times across reconnects and restarts.
// A delayed browser response is not a gap in the underlying pod history.
export function createMonitor() {
    const pods = new Map();
    const events = [];
    let incident = null;

    function event(host, message, kind, at) {
        events.unshift({host, message, kind, at});
        events.sort((a, b) => b.at - a.at);
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
        if (before && at <= pod.seenAt) return pod;
        const gap = before && at - pod.seenAt > STALE_MS;
        const targetRestarted = incident?.host === sample.host && at >= incident.at && sample.instanceId && incident.instanceId
            && sample.instanceId !== incident.instanceId;
        const restarted = before ? ((before.instanceId && sample.instanceId && before.instanceId !== sample.instanceId)
            || sample.uptime + 3 < before.uptime) : targetRestarted;
        if (restarted) {
            pod.restarts++;
            pod.high = false;
            event(sample.host, 'Process restarted', 'recovery', at);
        } else if (pod.stale) {
            event(sample.host, gap ? 'Samples resumed' : 'History caught up', gap ? 'recovery' : 'info', at);
        }
        if (sample.oom?.active && !before?.oom?.active) {
            event(sample.host, 'OOM allocation observed', 'kill', at);
        }
        if (sample.memory.percent >= 90 && !pod.high) {
            event(sample.host, 'Memory reached 90% of limit', 'warning', at);
            pod.high = true;
        } else if (sample.memory.percent < 80) {
            pod.high = false;
        }
        pod.points.push({at, sample, breakBefore: Boolean(restarted || gap)});
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
