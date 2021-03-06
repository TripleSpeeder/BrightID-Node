const db = require('./db');
const arango = require('@arangodb').db;
var CryptoJS = require("crypto-js");
const nacl = require('tweetnacl');
const {
  strToUint8Array,
  b64ToUint8Array,
  uInt8ArrayToB64,
  b64ToUrlSafeB64,
  urlSafeB64ToB64,
  hash
} = require('./encoding');

const TIME_FUDGE = 60 * 60 * 1000; // timestamp can be this far in the future (milliseconds) to accommodate client/server clock differences

const verifyUserSig = function(message, id, sig) {
  const user = db.loadUser(id);
  // this will happen for "Add Connection" when one party is not created
  // this also enable this version of code to be used by the old users collection
  // for users that don't have signingKey
  const signingKey = (user && user.signingKey) ? user.signingKey : urlSafeB64ToB64(id);
  if (!nacl.sign.detached.verify(strToUint8Array(message), b64ToUint8Array(sig), b64ToUint8Array(signingKey))) {
    throw 'invalid signature';
  }
}

const verifyContextSig = function(message, context, sig) {
  context = db.getContext(context);
  if (!context) {
    throw 'invalid context';
  }
  if (!nacl.sign.detached.verify(strToUint8Array(message), b64ToUint8Array(sig), b64ToUint8Array(context.sponsorPublicKey))) {
    throw 'invalid signature';
  }
}

const operationsData = {
  'Add Connection': {'attrs': ['id1', 'id2', 'sig1', 'sig2']},
  'Remove Connection': {'attrs': ['id1', 'id2', 'reason', 'sig1']},
  'Add Group': {'attrs': ['group', 'id1', 'id2', 'inviteData2', 'id3', 'inviteData3', 'url', 'type', 'sig1']},
  'Remove Group': {'attrs': ['id', 'group', 'sig']},
  'Add Membership': {'attrs': ['id', 'group', 'sig']},
  'Remove Membership': {'attrs': ['id', 'group', 'sig']},
  'Set Trusted Connections': {'attrs': ['id', 'trusted', 'sig']},
  'Set Signing Key': {'attrs': ['id', 'signingKey', 'id1', 'id2', 'sig1', 'sig2']},
  'Sponsor': {'attrs': ['id', 'contextId', 'context', 'sig']},
  'Link ContextId': {'attrs': ['id', 'contextId', 'context', 'sig']},
  'Invite': {'attrs': ['inviter', 'invitee', 'group', 'data', 'sig']},
  'Dismiss': {'attrs': ['dismisser', 'dismissee', 'group', 'sig']},
  'Add Admin': {'attrs': ['id', 'admin', 'group', 'sig']},
};

const defaultOperationKeys = ['name', 'timestamp', '_key', 'state', 'v'];

function verify(op) {
  if (op.v != 4) {
    throw 'invalid operation version';
  }
  if (op.timestamp > Date.now() + TIME_FUDGE) {
    throw "timestamp can't be in the future";
  }
  let message, validAttributes;
  if (op['name'] == 'Add Connection') {
    message = op.name + op.id1 + op.id2 + op.timestamp;
    verifyUserSig(message, op.id1, op.sig1);
    verifyUserSig(message, op.id2, op.sig2);
  } else if (op['name'] == 'Remove Connection') {
    message = op.name + op.id1 + op.id2 + op.reason + op.timestamp;
    verifyUserSig(message, op.id1, op.sig1);
  } else if (op['name'] == 'Add Group') {
    message = op.name + op.group + op.id1 + op.id2 + op.inviteData2 + op.id3 + op.inviteData3 + op.url + op.type + op.timestamp;
    verifyUserSig(message, op.id1, op.sig1);
  } else if (op['name'] == 'Remove Group') {
    message = op.name + op.id + op.group + op.timestamp;
    verifyUserSig(message, op.id, op.sig);
  } else if (op['name'] == 'Add Membership') {
    message = op.name + op.id + op.group + op.timestamp;
    verifyUserSig(message, op.id, op.sig);
  } else if (op['name'] == 'Remove Membership') {
    message = op.name + op.id + op.group + op.timestamp;
    verifyUserSig(message, op.id, op.sig);
  } else if (op['name'] == 'Set Trusted Connections') {
    message = op.name + op.id + op.trusted.join(',') + op.timestamp;
    verifyUserSig(message, op.id, op.sig);
  } else if (op['name'] == 'Set Signing Key') {
    message = op.name + op.id + op.signingKey + op.timestamp;
    verifyUserSig(message, op.id1, op.sig1);
    verifyUserSig(message, op.id2, op.sig2);
  } else if (op['name'] == 'Sponsor') {
    if (op.id) {
      message = 'Sponsor' + ',' + op.context + ',' + op.id;
    } else {
      message = 'Sponsor' + ',' + op.context + ',' + op.contextId;
    }
    verifyContextSig(message, op.context, op.sig);
  } else if (op['name'] == 'Link ContextId') {
    message = op.name + ',' + op.context + ',' + op.contextId + ',' + op.timestamp;
    verifyUserSig(message, op.id, op.sig);
  } else if (op['name'] == 'Invite') {
    message = op.name + op.inviter + op.invitee + op.group + op.data + op.timestamp;
    verifyUserSig(message, op.inviter, op.sig);
  } else if (op['name'] == 'Dismiss') {
    message = op.name + op.dismisser + op.dismissee + op.group + op.timestamp;
    verifyUserSig(message, op.dismisser, op.sig);
  } else if (op['name'] == 'Add Admin') {
    message = op.name + op.id + op.admin + op.group + op.timestamp;
    verifyUserSig(message, op.id, op.sig);
  } else {
    throw "invalid operation";
  }
  if (hash(message) != op._key) {
    throw 'invalid hash';
  }
  for (let k of Object.keys(op)) {
    if (defaultOperationKeys.indexOf(k)<0 && operationsData[op.name].attrs.indexOf(k)<0) {
      throw k + ' is not a valid attribute';
    }
  }
}

function apply(op) {
  if (op['name'] == 'Add Connection') {
    return db.addConnection(op.id1, op.id2, op.timestamp);
  } else if (op['name'] == 'Remove Connection') {
    return db.removeConnection(op.id1, op.id2, op.reason, op.timestamp);
  } else if (op['name'] == 'Add Group') {
    return db.createGroup(op.group, op.id1, op.id2, op.inviteData2, op.id3, op.inviteData3, op.url, op.type, op.timestamp);
  } else if (op['name'] == 'Remove Group') {
    return db.deleteGroup(op.group, op.id, op.timestamp);
  } else if (op['name'] == 'Add Membership') {
    return db.addMembership(op.group, op.id, op.timestamp);
  } else if (op['name'] == 'Remove Membership') {
    return db.deleteMembership(op.group, op.id, op.timestamp);
  } else if (op['name'] == 'Set Trusted Connections') {
    return db.setTrusted(op.trusted, op.id, op.timestamp);
  } else if (op['name'] == 'Set Signing Key') {
    return db.setSigningKey(op.signingKey, op.id, [op.id1, op.id2], op.timestamp);
  } else if (op['name'] == 'Sponsor') {
    return db.sponsor(op.id, op.context);
  } else if (op['name'] == 'Link ContextId') {
    return db.linkContextId(op.id, op.context, op.contextId, op.timestamp);
  } else if (op['name'] == 'Invite') {
    return db.invite(op.inviter, op.invitee, op.group, op.data, op.timestamp);
  } else if (op['name'] == 'Dismiss') {
    return db.dismiss(op.dismisser, op.dismissee, op.group, op.timestamp);
  } else if (op['name'] == 'Add Admin') {
    return db.addAdmin(op.id, op.admin, op.group, op.timestamp);
  } else {
    throw "invalid operation";
  }
  // fixme: add operation to operationHashes
}

function encrypt(op) {
  const { linkAESKey } = db.getContext(op.context);
  const jsonStr = JSON.stringify({ 'id': op.id, 'contextId': op.contextId });
  op.encrypted = CryptoJS.AES.encrypt(jsonStr, linkAESKey).toString();
  delete op.id;
  delete op.contextId;
}

function updateSponsorOp(op) {
  const { sponsorPrivateKey, collection } = db.getContext(op.context);
  const coll = arango._collection(collection);
  op.id = db.getUserByContextId(coll, op.contextId)
  if (!op.id) {
    throw 'unlinked context id';
  }

  let message = 'Sponsor' + ',' + op.context + ',' + op.id;
  op.sig = uInt8ArrayToB64(Object.values(nacl.sign.detached(strToUint8Array(message), b64ToUint8Array(sponsorPrivateKey))));
  op._key = hash(message);
  delete op.contextId;
}

function decrypt(op) {
  const { linkAESKey } = db.getContext(op.context);
  const decrypted = CryptoJS.AES.decrypt(op.encrypted, linkAESKey)
                      .toString(CryptoJS.enc.Utf8);
  const json = JSON.parse(decrypted);
  delete op.encrypted;
  op.id = json.id;
  op.contextId = json.contextId;
}

module.exports = {
  verify,
  apply,
  encrypt,
  decrypt,
  verifyUserSig,
  updateSponsorOp
};
