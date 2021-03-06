---
---
require("es6-shim");
var bip39 = require("bip39");
var Promise = require("bluebird");
var Mustache = require("mustache");
var ENS = require("ethereum-ens");
var EthereumTx = require("ethereumjs-tx");
var hdkey = require('ethereumjs-wallet/hdkey')
var ProviderEngine = require('web3-provider-engine')
var Web3Subprovider = require('web3-provider-engine/subproviders/web3.js')
var WalletSubprovider = require('ethereumjs-wallet/provider-engine')
var Web3 = require('web3');
var _ = require('underscore');

require('events').EventEmitter.defaultMaxListeners = 100;

var depositInterface = [
  {
    "constant": true,
    "inputs": [],
    "name": "totalPaidOut",
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "depositCount",
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "paidOut",
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ],
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [
      {
        "name": "addr",
        "type": "address"
      }
    ],
    "name": "check",
    "outputs": [
      {
        "name": "expires",
        "type": "uint256"
      },
      {
        "name": "deposit",
        "type": "uint256"
      }
    ],
    "type": "function"
  }
];
var depositContractAddress = '0xCD6608b1291d4307652592c29bFF7d51f1AD83d7';

var erc20Interface = [{"constant":true,"inputs":[],"name":"name","outputs":[{"name":"name","type":"string"}],"payable":false,"type":"function"},{"constant":false,"inputs":[{"name":"_spender","type":"address"},{"name":"_value","type":"uint256"}],"name":"approve","outputs":[{"name":"success","type":"bool"}],"payable":false,"type":"function"},{"constant":true,"inputs":[],"name":"totalSupply","outputs":[{"name":"totalSupply","type":"uint256"}],"payable":false,"type":"function"},{"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"success","type":"bool"}],"payable":false,"type":"function"},{"constant":true,"inputs":[],"name":"decimals","outputs":[{"name":"decimals","type":"uint8"}],"payable":false,"type":"function"},{"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"balance","type":"uint256"}],"payable":false,"type":"function"},{"constant":true,"inputs":[],"name":"symbol","outputs":[{"name":"symbol","type":"string"}],"payable":false,"type":"function"},{"constant":false,"inputs":[{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transfer","outputs":[{"name":"success","type":"bool"}],"payable":false,"type":"function"},{"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_spender","type":"address"}],"name":"allowance","outputs":[{"name":"remaining","type":"uint256"}],"payable":false,"type":"function"}];
var tokenDropInterface = [{"constant":false,"inputs":[{"name":"token","type":"address"},{"name":"v","type":"uint8"},{"name":"r","type":"bytes32"},{"name":"s","type":"bytes32"}],"name":"redeem","outputs":[],"payable":false,"type":"function"},{"constant":false,"inputs":[{"name":"token","type":"address"},{"name":"addresses","type":"address[]"},{"name":"quantity","type":"uint256"}],"name":"deposit","outputs":[],"payable":false,"type":"function"},{"constant":false,"inputs":[{"name":"token","type":"address"}],"name":"withdraw","outputs":[],"payable":false,"type":"function"},{"constant":false,"inputs":[{"name":"token","type":"address"},{"name":"recipient","type":"address"},{"name":"v","type":"uint8"},{"name":"r","type":"bytes32"},{"name":"s","type":"bytes32"}],"name":"redeemFor","outputs":[],"payable":false,"type":"function"},{"constant":true,"inputs":[{"name":"","type":"address"},{"name":"","type":"address"}],"name":"balances","outputs":[{"name":"","type":"uint256"}],"payable":false,"type":"function"},{"anonymous":false,"inputs":[{"indexed":true,"name":"token","type":"address"},{"indexed":true,"name":"owner","type":"address"},{"indexed":false,"name":"quantity","type":"uint256"}],"name":"TokensDeposited","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"name":"token","type":"address"},{"indexed":true,"name":"owner","type":"address"},{"indexed":true,"name":"recipient","type":"address"},{"indexed":false,"name":"quantity","type":"uint256"}],"name":"TokensRedeemed","type":"event"}];
var tokenDropAddress = '0x87a385231016524126b1e10be20247744949839e';

var tokens = _.indexBy(require("./js/tokens.json"), 'address');

function buildRedemptionForm(web3, wallet) {
    var systemWeb3 = web3;
    var accounts = web3.eth.accounts;
    var engine = new ProviderEngine();
    engine.addProvider(new WalletSubprovider(wallet, {}));
    engine.addProvider(new Web3Subprovider(web3.currentProvider));
    engine.start();
    var web3 = new Web3(engine);
    web3.eth = Promise.promisifyAll(web3.eth);

    var ens = new ENS(web3);

    var depositContract = web3.eth.contract(depositInterface);
    var deposit = Promise.promisifyAll(depositContract.at(depositContractAddress));

    var tokenContract = web3.eth.contract(erc20Interface);
    var tokenInstances = _.mapObject(tokens, function(token) {
        return Promise.promisifyAll(tokenContract.at(token.address));
    });

    var tokenDropContract = systemWeb3.eth.contract(tokenDropInterface);
    var tokenDrop = Promise.promisifyAll(tokenDropContract.at(tokenDropAddress));
    function signDrop(sender, token, recipient) {
        var data = tokenDrop.address + token.slice(2) + recipient.slice(2);
        return web3.eth.signAsync(sender, data).then(function(sigdata) {
            return {
                r: sigdata.slice(0, 66),
                s: "0x" + sigdata.slice(66, 130),
                v: parseInt(sigdata.slice(130, 132), 16),
            };
        });
    }

    var address = wallet.getAddressString();
    Promise.all([
        deposit.checkAsync(address),
        web3.eth.getBalanceAsync(address),
        Promise.props(_.mapObject(tokenInstances, function(token) {
            return token.balanceOfAsync(address);
        })),
        Promise.props(_.mapObject(tokens, function(token) {
            return tokenDrop.balancesAsync(token.address, address);
        }))
    ]).then(function(results) {
        var depositExpires = new Date(results[0][0].toNumber() * 1000);
        var depositValue = web3.fromWei(results[0][1]).toNumber();

        var etherBalance = results[1];
        var tokenBalances = results[2];
        var dropBalances = results[3];

        var balances = [];
        _.each(_.keys(tokenBalances), function(addr) {
            if(tokenBalances[addr] != 0) {
                balances.push({tokendrop: false, type: 'token', id: addr, typename: tokens[addr].symbol, balance: tokenBalances[addr] / Math.pow(10, tokens[addr].decimal)});
            }
            if(dropBalances[addr] != 0) {
                balances.push({tokendrop: true, id: 't' + addr, typename: tokens[addr].symbol, balance: dropBalances[addr] / Math.pow(10, tokens[addr].decimal)});
            }
        });

        var targets = [];
        for(var i = 0; i < accounts.length; i++) {
            targets.push({address: accounts[i]});
        }

        var template = $("#wallet-template").html();
        var rendered = Mustache.render(template, {
            address: address,
            depositValue: depositValue,
            depositExpires: depositExpires,
            balances: balances,
            etherBalance: web3.fromWei(etherBalance).toNumber(),
            hasBalances: balances.length > 0 || etherBalance > 0,
            hasTokenBalances: _.some(_.values(balances), function(entry) { return !entry.tokendrop; }),
            targets: targets,
        });
        $("#wallet").html(rendered);

        function getAddr() {
            var targetAddr = $(".targetradio:checked").val();
            if(targetAddr === "") targetAddr = $("#targetinput").val();

            var addrPromise;
            if(targetAddr !== undefined && targetAddr.indexOf(".") != -1) {
                // ENS name
                return ens.resolver(targetAddr).addr();
            } else {
                return Promise.resolve(targetAddr || '0x0000000000000000000000000000000000000000');
            }
        }

        function updateButton() {
            var balanceType = $(".balanceradio:checked").val();
            if(balanceType !== undefined && balanceType[0] == 't' && accounts.length == 0) {
                $("#sweepbutton").attr("disabled", "disabled");
                $("#dropwarning").css("visibility", "visible");
            } else {
                $("#dropwarning").css("visibility", "hidden");                
            }
            getAddr().then(function(addr) {
                if(balanceType !== undefined && addr !== '0x0000000000000000000000000000000000000000' && /0x[0-9a-fA-F]{40}/.test(addr)) {
                    $("#sweepbutton").removeAttr("disabled")
                } else {
                    $("#sweepbutton").attr("disabled", "disabled");
                }
            }).catch(function() {
                $("#sweepbutton").attr("disabled", "disabled");                
            });
        }

        $(".balanceradio,.targetradio").change(updateButton);
        $("#targetinput").focus(function() { $("#manualtarget").prop("checked", true); });
        $("#targetinput").keyup(updateButton);
        $("#sweepbutton").click(function() {
            if($("#sweepbutton").attr("disabled") == "disabled") return;

            var tokenAddr = $(".balanceradio:checked").val();
            var sent;
            getAddr().then(function(targetAddress) {
                sent = web3.eth.getGasPriceAsync().then(function(gasPrice) {
                    if(tokenAddr == "ether") {
                        var value = etherBalance.sub(gasPrice.times(23300));
                        return web3.eth.sendTransactionAsync({from: address, to: targetAddress, gasPrice: gasPrice, gas: 23300, value: value});
                    } else if(tokenAddr[0] === 't') {
                        tokenAddr = tokenAddr.slice(1);
                        return signDrop(address, tokenAddr, targetAddress).then(function(sig) {
                            return Promise.promisify(tokenDrop.redeemFor.estimateGas)(tokenAddr, targetAddress, sig.v, sig.r, sig.s).then(function(gasLimit) {
                                return tokenDrop.redeemForAsync(tokenAddr, targetAddress, sig.v, sig.r, sig.s, {from: accounts[0], gasPrice: gasPrice, gasLimit: gasLimit});
                            });
                        });
                    } else {
                        var token = tokenInstances[tokenAddr];
                        var tokenBalance = tokenBalances[tokenAddr].toString();
                        return Promise.promisify(token.transfer.estimateGas)(targetAddress, tokenBalance).then(function(gasLimit) {
                            return token.transferAsync(targetAddress, tokenBalance, {from: address, gasPrice: gasPrice, gasLimit: gasLimit});
                        });
                    }
                });
                sent.then(function(txid) {
                    $(".balanceradio:checked").parent().parent().remove();
                    updateButton();
                    $("#txid").html(txid);
                    $("#txidlink").attr("href", "https://etherscan.io/tx/" + txid);
                    $("#txSentModal").modal({keyboard: true});
                });
            });
        });
    });
}

$(document).ready(function() {
    var providerURL = 'https://mainnet.infura.io/Rg6BrBl8vIqJBc7AlL9h';
    if(typeof web3 === 'undefined') {
        web3 = new Web3();
        web3.setProvider(new web3.providers.HttpProvider(providerURL));
    }
    web3.eth = Promise.promisifyAll(web3.eth);

    // --------------------------------------------------------
    //  Navigation Bar
    // --------------------------------------------------------         
    $(window).scroll(function(){    
        "use strict";   
        var scroll = $(window).scrollTop();
        if( scroll > 10 ){
            $(".navbar").addClass("scroll-fixed-navbar");               
        } else {
            $(".navbar").removeClass("scroll-fixed-navbar");
        }
    }); 
    
    // --------------------------------------------------------
    //  Smooth Scrolling
    // --------------------------------------------------------     
    $(".navbar-nav li a[href^='#']").on('click', function(e) {
        e.preventDefault();
        var hash = this.hash;
        $('html, body').animate({
            scrollTop: $(hash).offset().top
            }, 1000, function(){
            window.location.hash = hash;
        });
    });
    
    // --------------------------------------------------------
    //  Scroll Up
    // --------------------------------------------------------     
    $(window).scroll(function() {
        if ($(this).scrollTop() > 100) {
            $('.scroll-up').fadeIn();
        } else {
            $('.scroll-up').fadeOut();
        }
    });

    $('.scroll-up').click(function() {
        $("html, body").animate({
            scrollTop: 0
        }, 600);
        return false;
    });

    // --------------------------------------------------------
    //  Redeem textarea
    // --------------------------------------------------------
    var lastMnemonic = "";
    $("#mnemonic").keyup(function() {
        var mnemonic = $("#mnemonic").val();
        if(mnemonic === lastMnemonic) return;
        lastMnemonic = mnemonic;

        if(!bip39.validateMnemonic(mnemonic)) {
            $("#wallet").html("");
            return;
        }

        var seed = bip39.mnemonicToSeed(mnemonic);
        var wallet = hdkey.fromMasterSeed(seed).derivePath("m/44'/60'/0'/0/0").getWallet();
        buildRedemptionForm(web3, wallet);
    });

    // --------------------------------------------------------
    //  Verify button
    // --------------------------------------------------------     
    $('#checkbutton').click(function() {

        var address = $('#checkaddress').val();

        function callback(err, result) {
            if(err != null) {
                $('#checkresult').html('<h3><i class="ion-close-circled"></i> Error</h3><p>Sorry, an error occurred looking up the address: ' + err + '</p>');
            } else {
                var timestamp = result[0].toNumber();
                if(timestamp == 0) {
                    // Not valid
                    $('#checkresult').html("<h3><i class=\"ion-close-circled\"></i> Invalid Address</h3><p>Sorry, that doesn't appear to be the address of a genuine ether.card. If you believe it should be, please <a href=\"mailto:cards@arachnidlabs.com\">contact us</a> with a picture of the card.</p>");
                } else {
                    var expires = new Date(timestamp * 1000);
                    var value = web3.fromWei(result[1]);
                    if(expires < new Date()) {
                        // Expired
                        $('#checkresult').html("<h3><i class=\"ion-checkmark-circled\"></i> Valid Card</h3><p>Yes! This is a valid Ether Card. However, its deposit and guarantee expired on <b>" + expires.toDateString() + "</b>.</p>");
                    } else {
                        // Valid
                        $('#checkresult').html("<h3><i class=\"ion-checkmark-circled\"></i> Valid Card</h3><p>Yes! This is a valid Ether Card. A total of <b>" + value + " ether</b> was deposited into the guarantee account for it. The guarantee expires <b>" + expires.toDateString() + "</b>.</p>");
                    }
                }
            }
        }

        try {
            var contract = web3.eth.contract(depositInterface).at(depositContractAddress);
            contract.check(address, callback);
        } catch(e) {
            callback(e, null);
        } 
    })
});

// --------------------------------------------------------
//  Collapse Navigation (Mobile) on click
// --------------------------------------------------------     
$(document).on('click','.navbar-collapse.in',function(e) {
    if( $(e.target).is('a') ) {
        $(this).collapse('hide');
    }
});
