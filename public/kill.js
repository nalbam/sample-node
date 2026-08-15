function _kill() {
    $.ajax({
        url: '/oom',
        type: 'post',
        success: function (res) {
            $('#kill-status').html(`killing ${res.host} ...`);
        },
        error: function () {
            $('#kill-status').html('kill failed');
        }
    });
}

$(function () {
    $('.btn-kill').click(function () {
        if (confirm('Kill this instance with OOM?')) {
            _kill();
        }
    });
});
