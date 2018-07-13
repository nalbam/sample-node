
let API_URL="https://sample-node.apps.opspresso.com";

let guid = function() {
    let nav = window.navigator;
    let screen = window.screen;
    let guid = nav.mimeTypes.length;
    guid += nav.userAgent.replace(/\D+/g, '');
    guid += nav.plugins.length;
    guid += screen.height || '';
    guid += screen.width || '';
    guid += screen.pixelDepth || '';
    return guid;
};

let set_cookie = function(name, value, exp) {
    let date = new Date();
    date.setTime(date.getTime() + (exp * 24 * 60 * 60 * 1000));
    document.cookie = name + '=' + value + ';expires=' + date.toUTCString() + ';path=/';
};

//$('#host').html(guid);
