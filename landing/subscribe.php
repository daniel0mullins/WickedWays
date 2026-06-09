<?php
require_once '../vendor/autoload.php';

function isVerifiedFetch() {
    return isset($_SERVER['HTTP_X_REQUESTED_BY']) && $_SERVER['HTTP_X_REQUESTED_BY'] === 'FetchAPI';
}

use Dotenv\Dotenv;
use MailchimpMarketing\ApiClient;

$dotenv = Dotenv::createImmutable('../');
$dotenv->safeLoad();

$client = new ApiClient();
$client->setConfig([
    'apiKey' => $_ENV['MAILCHIMP_API_KEY'] ?? null,
    'server' => $_ENV['MAILCHIMP_SERVER_PREFIX'] ?? null,
]);

$email = filter_input(INPUT_POST, 'email', FILTER_VALIDATE_EMAIL);
$listId = $_ENV['MAILCHIMP_LIST_ID'] ?? null;

if (!$email) {
    http_response_code(400);
    echo 'Invalid or missing email.';
    exit;
}

if (!$listId) {
    http_response_code(500);
    echo 'Missing MAILCHIMP_LIST_ID.';
    exit;
}

try {
    $client->lists->addListMember($listId, [
        'email_address' => $email,
        'status' => 'subscribed',
    ]);
    if (isVerifiedFetch()) {
        http_response_code(204);
    } else {
        header('Location: confirmed.html');
        http_response_code(303);
    }
} catch (\Throwable $e) {
    error_log('Mailchimp subscription failed: ' . $e->getMessage());
    if (isVerifiedFetch()) {
        http_response_code(500);
    } else {
        header('Location: 500.html');
        http_response_code(500);
    }
}