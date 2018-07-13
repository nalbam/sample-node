let API_URL = "https://sample-node.apps.opspresso.com";

function _get_counter(v) {
    let url = API_URL + '/counter/' + v;
    $.ajax({
        url: url,
        type: 'GET',
        dataType: 'json',
        success: function (res, status) {
            console.log('_get_counter (' + v + ') : ' + status);

            if (res) {
                $('#thumbs-' + res.name + '-count').html(res.count);
            }
        }
    });
}

function _post_counter(v, c) {
    let url = API_URL + '/counter/' + v + '/' + c;
    $.ajax({
        url: url,
        type: 'POST',
        dataType: 'json',
        success: function (res, status) {
            console.log('_post_counter (' + v + ', ' + c + ') : ' + status);

            if (res) {
                $('#thumbs-' + res.name + '-count').html(res.count);
            }
        }
    });
}

$(function () {
    _get_counter('up');
    _get_counter('down');
    setInterval(function () {
        _get_counter('up');
        _get_counter('down');
    }, 1000);
});

$(function () {
    $('.btn-thumbs-up').click(function () {
        _post_counter('up', 'incr');
    });
    $('.btn-thumbs-down').click(function () {
        _post_counter('down', 'decr');
    });
});
