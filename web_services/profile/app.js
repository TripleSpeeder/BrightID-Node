// app.js
var express = require('express');
var app = express();
var server = require('http').createServer(app);
var config = require("./config/config");
var bodyParser = require('body-parser');
const NodeCache = require( "node-cache" );
const dataCache = new NodeCache(config.node_cache);

// BodyParser Middleware
app.use(bodyParser.json({limit: "100kb"}));
app.use(bodyParser.urlencoded({extended: false}));

if(config.is_dev){
    app.use(express.static(__dirname + '/node_modules'));
    app.get('/test', function(req, res,next){
        res.sendFile(__dirname + '/index.html');
    });
}

app.get('/', function(req, res,next){
    console.log("test");
    res.send("BrightID socket server");
});

app.post('/upload', function(req, res, next){
    var data = req.body.data;
    var id = req.body.uuid;

    // support multiple upload to the same channel if `multiple` is set to true
    if (req.body.multiple === 'true') {
        var current_data = dataCache.get(id) || [];
        data = current_data.concat([data]);
    }

    // save data in cache
    dataCache.set(id, data, function(err, success){
        if(err){
            console.log(err);
        }
        var signal = JSON.stringify({
            signal: 'new_upload',
            uuid: id
        });
        res.send({success:1});
    });
});

app.get("/download/:uuid", function(req, res, next){
    var data = dataCache.get(req.params.uuid);
    res.send({
        data: data || null
    });
});

var port = config.port || 3000;
console.log("Listening on port: ", port);
server.listen(port, "localhost");
