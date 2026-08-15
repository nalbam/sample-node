/**
 * Rewrites server-rendered timestamps into the reader's own time zone.
 *
 * The server sends an ISO 8601 string with an offset, which stays readable if
 * this never runs.
 */

function _pad(n) {
    return String(n).padStart(2, '0');
}

function _local(date) {
    let day = `${date.getFullYear()}-${_pad(date.getMonth() + 1)}-${_pad(date.getDate())}`;
    let time = `${_pad(date.getHours())}:${_pad(date.getMinutes())}:${_pad(date.getSeconds())}`;
    let zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return zone ? `${day} ${time} ${zone}` : `${day} ${time}`;
}

document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('time[datetime]').forEach(function (el) {
        let date = new Date(el.dateTime);
        if (!isNaN(date.getTime())) {
            el.textContent = _local(date);
        }
    });
});
